import {
  approvalLimits,
  createApproval,
  expireApproval,
  getApproval,
  getPendingApprovalForChat,
} from "@/lib/db-approvals";
import { getChat, updateChat } from "@/lib/db-store";
import { getJob, updateJob } from "@/lib/db-jobs";
import { internalRunLeaseAuthorized } from "@/lib/internal-run-lease";
import { normalizeRuntimeMode } from "@/lib/runtime-mode";
import { bearerTokenMatches } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 960;

function authorized(req: Request) {
  return bearerTokenMatches(req, process.env.MCP_BEARER_TOKEN);
}

function contextHeaders(req: Request) {
  return {
    chatId: req.headers.get("x-ai-chat-id")?.trim() || "",
    userId: req.headers.get("x-ai-chat-user-id")?.trim() || undefined,
    jobId: req.headers.get("x-ai-chat-job-id")?.trim() || "",
  };
}

export async function GET(req: Request) {
  if (!authorized(req))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const params = new URL(req.url).searchParams;
  const id = params.get("id")?.trim() || "";
  const chatId = params.get("chatId")?.trim() || "";
  const { userId } = contextHeaders(req);
  if (!id && !chatId)
    return Response.json(
      { error: "id or chatId is required" },
      { status: 400 },
    );
  if (id) {
    const approval = getApproval(id, userId);
    if (!approval)
      return Response.json({ error: "Approval not found" }, { status: 404 });
    return Response.json({
      approvalId: approval.approvalId,
      status: approval.status,
      ...(approval.decision ? { decision: approval.decision } : {}),
    });
  }
  const chat = getChat(chatId, userId);
  if (!chat) return Response.json({ error: "Chat not found" }, { status: 404 });
  return Response.json({
    approvedPatterns: chat.approvedPatterns || [],
    pendingApproval: getPendingApprovalForChat(chatId, userId),
  });
}

export async function POST(req: Request) {
  if (!authorized(req))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { chatId, userId, jobId } = contextHeaders(req);
  if (!chatId || !jobId)
    return Response.json({ error: "Invalid chat context" }, { status: 400 });
  if (!internalRunLeaseAuthorized(req, jobId)) {
    return Response.json(
      { error: "Worker run lease is expired or invalid" },
      { status: 409 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    jobId?: unknown;
    chatId?: unknown;
    title?: unknown;
    toolName?: unknown;
    args?: unknown;
    command?: unknown;
    files?: unknown;
    sessionScope?: unknown;
    approvalId?: unknown;
    reason?: unknown;
  };
  const action = body.action === "expire" ? "expire" : "create";
  if (action === "expire") {
    const approvalId =
      typeof body.approvalId === "string" ? body.approvalId.trim() : "";
    if (
      !approvalId ||
      (typeof body.jobId === "string" && body.jobId.trim() !== jobId)
    ) {
      return Response.json(
        { error: "Invalid expiry request" },
        { status: 400 },
      );
    }
    const expired = expireApproval(
      approvalId,
      userId,
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim().slice(0, 500)
        : undefined,
    );
    if (!expired)
      return Response.json(
        { error: "Approval not found or already resolved" },
        { status: 404 },
      );
    releaseApprovalChatState(expired.chatId, expired.jobId, userId);
    return Response.json({ approvalId, status: "resolved", decision: "deny" });
  }

  const requestedChatId =
    typeof body.chatId === "string" ? body.chatId.trim() : chatId;
  const requestedJobId =
    typeof body.jobId === "string" ? body.jobId.trim() : jobId;
  if (requestedChatId !== chatId || requestedJobId !== jobId) {
    return Response.json(
      { error: "Approval context does not match request headers" },
      { status: 400 },
    );
  }
  const chat = getChat(chatId, userId);
  const currentJob = getJob(jobId);
  if (!chat || !currentJob) {
    return Response.json({ error: "Chat or job not found" }, { status: 404 });
  }
  if (
    chat.automationId ||
    currentJob.automationId ||
    normalizeRuntimeMode(chat.runtimeMode) !== "approval-required"
  ) {
    return Response.json(
      { error: "Runtime approval is not enabled for this run" },
      { status: 409 },
    );
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title)
    return Response.json({ error: "title is required" }, { status: 400 });
  const toolName =
    typeof body.toolName === "string" ? body.toolName.trim() : "";
  const hasArgs = body.args !== undefined;
  if (!toolName || !hasArgs)
    return Response.json(
      { error: "toolName and args are required" },
      { status: 400 },
    );
  const command =
    typeof body.command === "string"
      ? body.command
      : typeof toolName === "string"
        ? JSON.stringify(body.args ?? {})
        : String(body.args ?? "");
  const sessionScope =
    typeof body.sessionScope === "string" && body.sessionScope.trim()
      ? body.sessionScope.trim().slice(0, 2_000)
      : `${toolName}:${JSON.stringify(body.args ?? {})}`.slice(0, 2_000);
  if (command.length > approvalLimits().maxCommandLength) {
    return Response.json(
      { error: "Approval command is too long" },
      { status: 413 },
    );
  }
  const files = Array.isArray(body.files)
    ? body.files
        .map((item) => {
          const record =
            item && typeof item === "object"
              ? (item as Record<string, unknown>)
              : {};
          return {
            path: typeof record.path === "string" ? record.path : "",
            status:
              typeof record.status === "string" ? record.status : "pending",
          };
        })
        .filter((item) => item.path)
        .slice(0, approvalLimits().maxFiles)
    : undefined;

  const { approvalId } = createApproval({
    jobId,
    chatId,
    ownerId: userId,
    title,
    command,
    files,
    sessionScope,
  });
  const createdAt = new Date().toISOString();
  if (
    currentJob &&
    [
      "queued",
      "running",
      "switching",
      "waiting_input",
      "waiting_for_user",
    ].includes(currentJob.status)
  ) {
    updateJob(jobId, { status: "waiting_input", runId: jobId });
  }
  updateChat(
    chatId,
    {
      runStatus: "waiting_for_user",
      pendingApproval: {
        id: approvalId,
        title,
        ...(command ? { command } : {}),
        ...(files?.length ? { files } : {}),
        createdAt,
      },
    },
    userId,
  );
  return Response.json({ approvalId });
}

function releaseApprovalChatState(
  chatId: string,
  jobId: string,
  userId?: string,
) {
  const currentJob = getJob(jobId);
  if (currentJob?.status === "waiting_input")
    updateJob(jobId, { status: "running" });
  const currentChat = getChat(chatId, userId);
  if (currentChat?.pendingApproval) {
    updateChat(chatId, { runStatus: "running", pendingApproval: null }, userId);
  }
}
