import { runAgentTimedWait } from "@/lib/agent-wait";
import { internalRunLeaseAuthorized } from "@/lib/internal-run-lease";
import { getJob, listChildJobs, listRunEvents } from "@/lib/db-jobs";
import { getChat } from "@/lib/db-store";
import { bearerTokenMatches } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 960;

const MAX_WAIT_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function GET(req: Request) {
  if (!bearerTokenMatches(req, process.env.MCP_BEARER_TOKEN)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json({ ok: true, service: "agent-state" });
}

function subagentStatuses(chatId: string, userId: string | undefined, jobId: string, afterEventId = 0, agentId?: string) {
  const events = listRunEvents(chatId, userId, afterEventId, jobId);
  const byAgent = new Map<string, Record<string, unknown>>();
  let lastEventId = afterEventId;
  for (const event of events) {
    const item = event as unknown as { id: number; event: string; data: Record<string, unknown>; createdAt: string };
    lastEventId = Math.max(lastEventId, item.id);
    if (item.event !== "tool") continue;
    const data = item.data;
    const subagent = data.subagent as Record<string, unknown> | undefined;
    if (data.kind !== "subagent" && !subagent) continue;
    const candidateId = typeof subagent?.agentId === "string"
      ? subagent.agentId
      : typeof data.agentId === "string"
        ? data.agentId
        : typeof data.callId === "string"
          ? data.callId
          : undefined;
    if (!candidateId || (agentId && candidateId !== agentId)) continue;
    byAgent.set(candidateId, {
      agentId: candidateId,
      name: data.name,
      status: data.status,
      title: subagent?.title,
      model: subagent?.model,
      mode: subagent?.mode,
      updatedAt: item.createdAt,
    });
  }

  // Provider-neutral delegated agents run as durable child Metis jobs. Merge
  // them with Cursor-native task events so subagent_status has one contract for
  // every provider instead of forcing the parent model to know the backend.
  for (const child of listChildJobs(jobId, userId)) {
    if (agentId && child.id !== agentId) continue;
    const childChat = getChat(child.chatId, userId);
    const assistant = childChat
      ? [...childChat.messages].reverse().find((message) => message.role === "assistant")
      : undefined;
    const status = ["queued", "running", "switching", "waiting_input", "waiting_for_user"].includes(child.status)
      ? "running"
      : child.status;
    byAgent.set(child.id, {
      agentId: child.id,
      chatId: child.chatId,
      name: "delegate_subagent",
      status,
      title: child.subagentTitle,
      model: child.modelId,
      mode: child.modeId,
      output: assistant?.content || "",
      error: child.error || assistant?.errorMessage,
      ...(assistant?.runMetadata && typeof assistant.runMetadata === "object"
        ? { usage: assistant.runMetadata }
        : {}),
      updatedAt: child.updatedAt,
    });
  }
  return { agents: [...byAgent.values()], lastEventId };
}

export async function POST(req: Request) {
  if (!bearerTokenMatches(req, process.env.MCP_BEARER_TOKEN)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const chatId = req.headers.get("x-ai-chat-id")?.trim() || "";
  const userId = req.headers.get("x-ai-chat-user-id")?.trim() || undefined;
  const jobId = req.headers.get("x-ai-chat-job-id")?.trim() || "";
  if (jobId && !internalRunLeaseAuthorized(req, jobId)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!chatId || !jobId || !getChat(chatId, userId)) {
    return Response.json({ error: "Invalid chat context" }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    duration?: unknown;
    durationMs?: unknown;
    reason?: unknown;
    waitMs?: unknown;
    afterEventId?: unknown;
    agentId?: unknown;
  };

  if (body.action === "wait") {
    const presetMs = body.duration === "10s" ? 10_000 : body.duration === "5m" ? 5 * 60_000 : body.duration === "60s" ? 60_000 : undefined;
    const requestedMs = typeof body.durationMs === "number" && Number.isFinite(body.durationMs)
      ? Math.floor(body.durationMs)
      : presetMs;
    if (!requestedMs) return Response.json({ error: "duration must be 10s, 60s, 5m, or durationMs" }, { status: 400 });
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(1_000, requestedMs));
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : undefined;
    try {
      return Response.json(await runAgentTimedWait({
        jobId,
        chatId,
        userId,
        waitMs,
        reason,
      }));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "The agent wait was cancelled." },
        { status: 409 },
      );
    }
  }

  if (body.action !== "status") return Response.json({ error: "Unknown action" }, { status: 400 });
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : undefined;
  const afterEventId = typeof body.afterEventId === "number" ? Math.max(0, Math.floor(body.afterEventId)) : 0;
  const waitMs = typeof body.waitMs === "number" ? Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(body.waitMs))) : 0;
  const deadline = Date.now() + waitMs;
  let result = subagentStatuses(chatId, userId, jobId, afterEventId, agentId);
  let delayMs = 250;
  while (waitMs > 0 && Date.now() < deadline && !result.agents.some((agent) => agent.status !== "running")) {
    const parent = getJob(jobId);
    if (parent && !["running", "queued", "waiting_input", "waiting_for_user"].includes(parent.status)) break;
    await sleep(Math.min(delayMs, Math.max(50, deadline - Date.now())));
    delayMs = Math.min(2_000, delayMs * 2);
    result = subagentStatuses(chatId, userId, jobId, result.lastEventId, agentId);
    const job = getJob(jobId);
    if (job && !["running", "queued", "waiting_input", "waiting_for_user"].includes(job.status)) break;
  }
  return Response.json({ ...result, jobStatus: getJob(jobId)?.status || "unknown" });
}
