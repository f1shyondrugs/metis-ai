import { createHash } from "node:crypto";
import { internalRunLeaseAuthorized } from "@/lib/internal-run-lease";
import { appendMessage, createChat, getChat, getGlobalModelSettings, updateChat } from "@/lib/db-store";
import { cancelChildJobs, enqueueJob, getJob, listChildJobs, updateJob } from "@/lib/db-jobs";
import { bearerTokenMatches } from "@/lib/security";
import { parseWorkerConcurrency } from "@/lib/worker-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1900;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ACTIVE = new Set(["queued", "running", "switching", "waiting_input", "waiting_for_user"]);
const MAX_DEPTH = 4;
const MAX_CHILDREN = 8;
const MAX_WAIT_MS = 30 * 60_000;

export async function GET(req: Request) {
  if (!bearerTokenMatches(req, process.env.MCP_BEARER_TOKEN)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json({ ok: true, service: "subagent" });
}

function finalChildResult(chatId: string, userId?: string) {
  const chat = getChat(chatId, userId);
  const assistant = chat ? [...chat.messages].reverse().find((message) => message.role === "assistant") : undefined;
  return {
    runStatus: chat?.runStatus,
    output: assistant?.content || "",
    error: assistant?.errorMessage,
    messages: (chat?.messages || []).slice(-24).map((message) => ({
      role: message.role,
      text: message.content,
      ...(message.createdAt ? { timestamp: message.createdAt } : {}),
    })),
  };
}

export async function POST(req: Request) {
  if (!bearerTokenMatches(req, process.env.MCP_BEARER_TOKEN)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parentChatId = req.headers.get("x-ai-chat-id")?.trim() || "";
  const userId = req.headers.get("x-ai-chat-user-id")?.trim() || undefined;
  const parentJobId = req.headers.get("x-ai-chat-job-id")?.trim() || "";
  const parentJob = parentJobId ? getJob(parentJobId) : null;
  const parentChat = parentChatId ? getChat(parentChatId, userId) : null;
  if (!parentJob || !parentChat || parentJob.chatId !== parentChatId) {
    return Response.json({ error: "Invalid parent agent context" }, { status: 400 });
  }
  if (!internalRunLeaseAuthorized(req, parentJobId)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!ACTIVE.has(parentJob.status)) {
    return Response.json({ error: "The parent agent is no longer active." }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 100_000) : "";
  if (!prompt) return Response.json({ error: "prompt is required" }, { status: 400 });
  const workerConcurrency = parseWorkerConcurrency(process.env.AI_CHAT_WORKER_CONCURRENCY);
  if (Number.isFinite(workerConcurrency) && workerConcurrency < 2) {
    return Response.json({
      error: "Provider-neutral subagents require at least 2 worker slots so the parent and child cannot deadlock. Increase AI_CHAT_WORKER_CONCURRENCY or complete this scope in the parent agent.",
    }, { status: 409 });
  }
  const title = (typeof body.title === "string" ? body.title.trim() : "")
    .slice(0, 160) || prompt.split(/\r?\n/)[0]?.slice(0, 120) || "Subagent";
  const dedupeId = createHash("sha256")
    .update(`${parentJobId}\n${title.toLocaleLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
  const existingChild = listChildJobs(parentJobId, userId).find((child) => child.subagentDedupeId === dedupeId);
  if (existingChild) {
    return Response.json({
      agentId: existingChild.id,
      jobId: existingChild.id,
      chatId: existingChild.chatId,
      title: existingChild.subagentTitle,
      model: existingChild.modelId,
      mode: existingChild.modeId,
      status: existingChild.status,
      delegated: true,
      deduplicated: true,
    });
  }
  if (listChildJobs(parentJobId, userId).length >= MAX_CHILDREN) {
    return Response.json({ error: `A parent agent may have at most ${MAX_CHILDREN} children.` }, { status: 409 });
  }
  const depth = Math.max(0, parentJob.subagentDepth || 0) + 1;
  if (depth > MAX_DEPTH) {
    return Response.json({ error: `Subagent delegation depth is limited to ${MAX_DEPTH}.` }, { status: 400 });
  }

  const preferences = getGlobalModelSettings(userId);
  const requestedModel = typeof body.modelId === "string" ? body.modelId.trim().slice(0, 300) : "";
  const modelId = requestedModel
    || parentJob.extendedModelId
    || (preferences.subagentModelEnabled ? preferences.subagentModelId : undefined)
    || parentJob.modelId
    || parentChat.modelId;
  const requestedMode = typeof body.modeId === "string" ? body.modeId.trim().slice(0, 80) : "";
  const parentModeId = parentJob.modeId || parentChat.sessionState?.modeId || "agent";
  // Delegation must not become a permission-escalation path. Read-only/custom
  // parent modes keep their exact policy; Agent mode may deliberately delegate
  // a narrower child mode.
  const modeId = parentModeId === "agent" && requestedMode ? requestedMode : parentModeId;

  const wait = body.wait !== false;
  const requestedTimeout = typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs)
    ? Math.floor(body.timeoutMs)
    : 10 * 60_000;
  const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(1_000, requestedTimeout));
  const child = createChat(title, undefined, userId, modelId ? { id: modelId } : undefined);
  updateChat(child.id, {
    archived: true,
    runStatus: "running",
    runUpdatedAt: new Date().toISOString(),
    sessionState: { ...(child.sessionState || {}), modeId },
  }, userId);
  const messageId = crypto.randomUUID();
  appendMessage(child.id, { id: messageId, role: "user", content: prompt });
  const childJob = enqueueJob({
    chatId: child.id,
    userId,
    message: prompt,
    messageId,
    modeId,
    ...(modelId ? { modelId } : {}),
    parentJobId,
    parentChatId,
    subagentTitle: title,
    subagentDedupeId: dedupeId,
    subagentRequired: wait,
    subagentDepth: depth,
    ...(wait === false ? { subagentAutoReview: true } : {}),
    ...(parentJob.maxRuntimeMs ? { maxRuntimeMs: parentJob.maxRuntimeMs } : {}),
  });

  if (!wait) {
    return Response.json({
      agentId: childJob.id,
      jobId: childJob.id,
      chatId: child.id,
      title,
      model: modelId,
      mode: modeId,
      status: childJob.status,
      delegated: true,
    });
  }

  const deadline = Date.now() + timeoutMs;
  let current = getJob(childJob.id);
  while (current && ACTIVE.has(current.status) && Date.now() < deadline) {
    await sleep(400);
    current = getJob(childJob.id);
  }
  const result = finalChildResult(child.id, userId);
  if (current && ACTIVE.has(current.status)) {
    updateJob(childJob.id, { status: "cancelled", error: "Subagent timed out." });
    // The child may already have delegated descendants while the parent was
    // waiting. Keep timeout cancellation terminal across that subtree.
    cancelChildJobs(childJob.id, userId, "Subagent timed out.");
    return Response.json({
      agentId: childJob.id,
      jobId: childJob.id,
      chatId: child.id,
      title,
      model: modelId,
      mode: modeId,
      status: current.status,
      delegated: true,
      timedOut: true,
      ...result,
    });
  }
  return Response.json({
    agentId: childJob.id,
    jobId: childJob.id,
    chatId: child.id,
    title,
    model: modelId,
    mode: modeId,
    status: current?.status || "unknown",
    delegated: true,
    ...result,
  });
}
