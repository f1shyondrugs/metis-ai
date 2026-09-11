import { appendRunEvent, getJob, updateJob } from "@/lib/db-jobs";
import { internalRunLeaseAuthorized } from "@/lib/internal-run-lease";
import {
  createPendingQuestion,
  getPendingQuestion,
} from "@/lib/db-questions";
import { canTransitionRunStatus, getChat, updateChat } from "@/lib/db-store";
import { bearerTokenMatches } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 960;

type QuestionInput = {
  question?: unknown;
  multiple?: unknown;
  options?: unknown;
};

function authorized(req: Request) {
  return bearerTokenMatches(req, process.env.MCP_BEARER_TOKEN);
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const chatId = req.headers.get("x-ai-chat-id")?.trim() || "";
  const userId = req.headers.get("x-ai-chat-user-id")?.trim() || undefined;
  const jobId = req.headers.get("x-ai-chat-job-id")?.trim() || "";
  if (req.headers.get("x-ai-chat-automation") === "1") {
    return Response.json({ error: "User questions are unavailable during automation runs." }, { status: 403 });
  }
  const chat = chatId ? getChat(chatId, userId) : null;
  if (!chat || !jobId) return Response.json({ error: "Invalid chat context" }, { status: 400 });
  if (!internalRunLeaseAuthorized(req, jobId)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { questions?: unknown };
  const rawQuestions = Array.isArray(body.questions) ? body.questions : [];
  const questions = rawQuestions
    .filter((item): item is QuestionInput => Boolean(item) && typeof item === "object")
    .map((item) => ({
      question: typeof item.question === "string" ? item.question : "",
      multiple: item.multiple === true,
      options: Array.isArray(item.options) ? item.options.filter((option) => typeof option === "string") : undefined,
    }))
    .filter((item) => item.question.trim());
  if (!questions.length) return Response.json({ error: "At least one question is required" }, { status: 400 });

  const pending = createPendingQuestion(questions, chatId, userId, { jobId, runId: jobId });
  updateJob(jobId, { status: "waiting_input", runId: jobId });
  updateChat(chatId, {
    runStatus: "waiting_for_user",
    pendingQuestion: {
      questionId: pending.questionId,
      jobId,
      runId: jobId,
      version: pending.version,
      expiresAt: pending.expiresAt,
      status: "waiting_for_user",
      questions: pending.questions,
    },
  }, userId);
  appendRunEvent(jobId, chatId, userId, "question", {
    questionId: pending.questionId,
    jobId,
    runId: jobId,
    version: pending.version,
    expiresAt: pending.expiresAt,
    questions: pending.questions,
  });

  const answers = await pending.promise;
  const resolved = getPendingQuestion(pending.questionId, userId);
  if (!resolved || resolved.status !== "answered") {
    const nextJobStatus = resolved?.status === "cancelled" ? "cancelled" : "interrupted";
    const currentJob = getJob(jobId);
    if (currentJob && ["queued", "running", "switching", "waiting_input", "waiting_for_user"].includes(currentJob.status)) {
      updateJob(jobId, {
        status: nextJobStatus,
        error: resolved?.status === "expired" ? "The question expired before it was answered." : "The question was cancelled.",
      });
    }
    const currentChat = getChat(chatId, userId);
    if (
      currentChat?.pendingQuestion?.questionId === pending.questionId &&
      canTransitionRunStatus(currentChat.runStatus || "idle", nextJobStatus)
    ) {
      updateChat(chatId, { runStatus: nextJobStatus, pendingQuestion: null }, userId);
    }
    appendRunEvent(jobId, chatId, userId, "status", { status: resolved?.status || "interrupted", questionId: pending.questionId });
    throw new Error(resolved?.status === "expired" ? "The user question expired." : "The user question was cancelled.");
  }
  updateJob(jobId, { status: "running" });
  updateChat(chatId, { runStatus: "running", pendingQuestion: null }, userId);
  return Response.json({ questionId: pending.questionId, answers });
}
