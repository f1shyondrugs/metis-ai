import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import { appendRunEvent, requestJobCancel, updateJob } from "@/lib/db-jobs";
import { resolveApproval } from "@/lib/db-approvals";
import { cancelQuestion } from "@/lib/db-questions";
import { getChat, updateChat } from "@/lib/db-store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await isAuthenticated(req))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { chatId?: string };
  const chatId = body.chatId?.trim();
  if (!chatId) return Response.json({ error: "chatId is required" }, { status: 400 });
  const userId = (await getAuthenticatedUserId(req)) ?? undefined;
  const chat = getChat(chatId, userId);
  if (chat?.pendingApproval?.id) {
    const denied = resolveApproval(chat.pendingApproval.id, "deny", userId);
    if (denied) {
      updateChat(chatId, { runStatus: "cancelled", pendingApproval: null, badge: null }, userId);
      if (denied.jobId) {
        updateJob(denied.jobId, { status: "cancelled", error: "Approval denied by user." });
        appendRunEvent(denied.jobId, chatId, userId, "status", { status: "cancelled", approvalId: chat.pendingApproval.id });
      }
      return Response.json({ ok: true, status: "cancelled" });
    }
  }
  if (chat?.pendingQuestion?.questionId) {
    const cancelled = cancelQuestion(chat.pendingQuestion.questionId, userId);
    if (cancelled) {
      if (cancelled.jobId) updateJob(cancelled.jobId, { status: "cancelled", error: "Question cancelled by user." });
      updateChat(chatId, { runStatus: "cancelled", pendingQuestion: null, badge: null }, userId);
      if (cancelled.jobId) appendRunEvent(cancelled.jobId, chatId, userId, "status", { status: "cancelled", questionId: chat.pendingQuestion.questionId });
      return Response.json({ ok: true, status: "cancelled" });
    }
  }
  const active = requestJobCancel(chatId, userId);
  if (!active) return Response.json({ error: "No active run" }, { status: 404 });
  return Response.json({ ok: true, status: "cancel-requested" });
}
