import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { writeWorkerHeartbeat } from "@/lib/worker-health";
import { appendRunEvent, cancelChildJobs, claimNextJob, enqueueJob, getActiveJob, getJob, listChildJobs, reapExpiredJobLeases, recoverStaleJobs, requeueSwitchingJob, updateJob } from "@/lib/db-jobs";
import { snapshotInterruptedJob } from "@/lib/recovery";
import { appendMessage, appendMessageInTransaction, getChat, listChatsWithQueuedMessages, removeQueuedMessage, updateChat, upsertMessage } from "@/lib/db-store";
import { expirePendingQuestions } from "@/lib/db-questions";
import {
  claimDueAutomations,
  failAutomationClaim,
  finalizeAutomationRunForJob,
  queueAutomationRun,
} from "@/lib/automations";
import { parseWorkerConcurrency, waitForSchedulerTick } from "@/lib/worker-scheduler";
import { logError } from "@/lib/error-logs";

const pollMs = Number(process.env.AI_CHAT_WORKER_POLL_MS || 500);
const concurrency = parseWorkerConcurrency(process.env.AI_CHAT_WORKER_CONCURRENCY);
const HARD_CAP_MS = 7 * 24 * 60 * 60_000;
const configuredMaxJobMsRaw = process.env.AI_CHAT_WORKER_MAX_JOB_MS;
const configuredMaxJobMs = configuredMaxJobMsRaw === undefined || configuredMaxJobMsRaw === ""
  ? 0
  : Number(configuredMaxJobMsRaw);
const maxJobMs = !Number.isFinite(configuredMaxJobMs) || configuredMaxJobMs <= 0
  ? 0
  : Math.max(60_000, configuredMaxJobMs);
const configuredCrashRetries = Number(process.env.AI_CHAT_WORKER_CRASH_RETRIES || 2);
const crashRetries = Number.isFinite(configuredCrashRetries)
  ? Math.max(0, Math.min(5, Math.floor(configuredCrashRetries)))
  : 2;
let stopping = false;

function stop() {
  stopping = true;
}

function runJobInIsolatedProcess(claimedJob: Awaited<ReturnType<typeof claimNextJob>>) {
  if (!claimedJob) return Promise.resolve();
  const jobId = claimedJob.id;
  return new Promise<void>((resolveProcess, reject) => {
    const markFailed = (message: string) => {
      const beforeFailure = getJob(jobId);
      if (!beforeFailure || ["cancelled", "interrupted", "completed"].includes(beforeFailure.status)) {
        console.warn(`[ai-chat-worker] ignored child failure for terminal job ${jobId} (${beforeFailure?.status || "missing"})`);
        return;
      }
      try {
        updateJob(jobId, { status: "error", error: message });
        cancelChildJobs(jobId, beforeFailure.userId, "Parent agent failed.");
        const failedJob = getJob(jobId);
        void logError({
          level: "error",
          source: "worker",
          chatId: failedJob?.chatId,
          userId: failedJob?.userId || undefined,
          message: `Worker process failed: ${message}`,
          context: { jobId, stderrTail: stderr.slice(-2000) },
        });
      } catch (error) {
        // Failure reporting itself must never terminate the scheduler.
        console.error(`[ai-chat-worker] could not persist failure for ${jobId}`, error);
        return;
      }
      const job = getJob(jobId);
      if (job && job.status === "error") {
        appendRunEvent(job.id, job.chatId, job.userId, "error", { message });
        const chat = getChat(job.chatId, job.userId);
        if (chat && !chat.messages.some(
          (entry) => entry.role === "assistant" && (
            entry.errorMessage === message || entry.content.includes(message)
          ),
        )) {
          const pendingAssistant = [...chat.messages]
            .reverse()
            .find((entry) => entry.role === "assistant" && !entry.content.trim());
          if (pendingAssistant) {
            upsertMessage(job.chatId, {
              id: pendingAssistant.id,
              role: "assistant",
              content: "",
              errorMessage: message,
            });
          } else {
            appendMessage(job.chatId, {
              role: "assistant",
              content: "",
              errorMessage: message,
            });
          }
        }
        updateChat(job.chatId, {
          runStatus: "error",
          runUpdatedAt: new Date().toISOString(),
          badge: "red",
        }, job.userId);
      }
    };
    const requeueUnexpectedCrash = (message: string) => {
      const current = getJob(jobId);
      if (!current || current.status !== "running") return false;
      // attempts is incremented when a job is claimed. Two crash retries means
      // at most three isolated-process attempts for the same logical run.
      if (current.attempts >= crashRetries + 1) return false;
      const resumedAt = new Date().toISOString();
      const updated = updateJob(jobId, {
        status: "queued",
        error: undefined,
        resumePrompt: "The isolated worker process crashed unexpectedly. Resume from the saved agent/chat/tool/browser state. Do not repeat completed tool calls or user-facing work.",
        resumeRequestedAt: resumedAt,
      });
      if (!updated) return false;
      updateChat(current.chatId, {
        runStatus: "running",
        runUpdatedAt: resumedAt,
        queueMessage: null,
        badge: null,
      }, current.userId);
      appendRunEvent(current.id, current.chatId, current.userId, "status", {
        status: "recovering",
        message: "Worker process restarted automatically; continuing from the last checkpoint.",
        attempt: current.attempts + 1,
      });
      void logError({
        level: "warn",
        source: "worker",
        chatId: current.chatId,
        userId: current.userId || undefined,
        message: "Unexpected worker child exit; automatically resumed the run.",
        context: { jobId, attempt: current.attempts, detail: message.slice(-1200) },
      });
      return true;
    };
    let forceKillTimer: NodeJS.Timeout | undefined;
    let stderr = "";
    const requestedJobMaxMs = Number(getJob(jobId)?.maxRuntimeMs);
    const jobMaxMs = Number.isFinite(requestedJobMaxMs) && requestedJobMaxMs > 0
      ? Math.max(60_000, Math.min(requestedJobMaxMs, HARD_CAP_MS))
      : maxJobMs;
    const timeout = jobMaxMs > 0
      ? setTimeout(() => {
        markFailed(`Worker job exceeded the ${Math.round(jobMaxMs / 60_000)} minute limit.`);
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      }, jobMaxMs)
      : undefined;
    const child = spawn(
      process.execPath,
      [resolve("node_modules/tsx/dist/cli.mjs"), "worker-job.ts", jobId],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(claimedJob.leaseOwner ? { AI_CHAT_WORKER_ID: claimedJob.leaseOwner } : {}),
          ...(claimedJob.leaseToken ? { AI_CHAT_JOB_LEASE_TOKEN: claimedJob.leaseToken } : {}),
          AI_CHAT_JOB_ID: claimedJob.id,
        },
        stdio: ["ignore", "inherit", "pipe"],
      },
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
    });
    child.once("error", (error) => {
      const message = `Could not start isolated worker: ${error instanceof Error ? error.message : String(error)}`;
      if (requeueUnexpectedCrash(message)) {
        resolveProcess();
        return;
      }
      markFailed(message);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (code === 0) {
        const current = getJob(jobId);
        if (current?.status === "running") {
          const message =
            "Isolated worker exited cleanly without publishing a terminal run state.";
          if (requeueUnexpectedCrash(message)) {
            console.warn(`[ai-chat-worker] ${message} Requeued ${jobId} from its durable checkpoint.`);
            resolveProcess();
            return;
          }
          markFailed(message);
        }
        resolveProcess();
        return;
      }
      const baseMessage = signal
        ? `Isolated worker exited with signal ${signal}.`
        : `Isolated worker exited with code ${code ?? "unknown"}.`;
      const detail = stderr
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
        .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
        .split(/\r?\n/)
        .filter((line) => !/ExperimentalWarning|node --trace-warnings/i.test(line))
        .join("\n")
        .trim();
      const message = detail ? `${baseMessage} ${detail.slice(-2_000)}` : baseMessage;
      const current = getJob(jobId);
      if (!current || ["cancelled", "interrupted", "completed", "switching"].includes(current.status)) {
        resolveProcess();
        return;
      }
      if (stopping && current.status === "running") {
        const resumedAt = new Date().toISOString();
        updateJob(jobId, {
          status: "queued",
          error: undefined,
          resumePrompt: "The worker stopped intentionally. Continue from the last saved agent/chat/tool/browser state without repeating completed work.",
          resumeRequestedAt: resumedAt,
        });
        updateChat(current.chatId, {
          runStatus: "running",
          runUpdatedAt: resumedAt,
          queueMessage: null,
          badge: null,
        }, current.userId);
        appendRunEvent(current.id, current.chatId, current.userId, "status", {
          status: "recovering",
          message: "Worker stopped intentionally; the run will continue when the worker is available again.",
        });
        resolveProcess();
        return;
      }
      if (requeueUnexpectedCrash(message)) {
        resolveProcess();
        return;
      }
      markFailed(message);
      reject(new Error(message));
    });
  });
}

function reconcileSubagentParent(parentJobId: string) {
 const parent = getJob(parentJobId);
 if (!parent || parent.subagentFollowUp || !["completed", "error", "cancelled", "interrupted"].includes(parent.status)) return;
 const children = listChildJobs(parent.id, parent.userId);
 const asyncChildren = children.filter((child) => child.subagentAutoReview && !child.subagentFollowUp);
 if (!asyncChildren.length || asyncChildren.some((child) => ["queued", "running", "switching", "waiting_input", "waiting_for_user"].includes(child.status))) return;
 if (children.some((child) => child.subagentFollowUp)) return;

 const outcomes = asyncChildren.map((child) => {
 const childChat = getChat(child.chatId, child.userId);
 const assistant = childChat
 ? [...childChat.messages].reverse().find((message) => message.role === "assistant")
 : undefined;
 const state = child.status === "completed" ? "completed" : child.status;
 return `- ${child.subagentTitle || "Subagent"} (${state})${child.error ? `: ${child.error}` : assistant?.content ? `: ${assistant.content.slice(0, 2_000)}` : ""}`;
 }).join("\\n");
 const reviewPrompt = [
 "Automatic subagent lifecycle review.",
 "All asynchronous subagents for the parent run are now terminal. Inspect their outcomes and the current working tree, verify whether their requested work was actually completed, and fix or adjust incomplete, conflicting, or failed work yourself. Do not merely summarize the reports. Preserve successful changes and avoid repeating completed work.",
 "Child outcomes:",
 outcomes,
 ].join("\\n\\n");
 const messageId = randomUUID();
 const reviewJob = enqueueJob({
 chatId: parent.chatId,
 userId: parent.userId,
 message: reviewPrompt,
 messageId,
 modeId: parent.modeId,
 modelId: parent.modelId,
 extendedModelId: parent.extendedModelId,
 modelParams: parent.modelParams,
 parentJobId: parent.id,
 parentChatId: parent.chatId,
 subagentTitle: "Subagent lifecycle review",
 subagentDepth: parent.subagentDepth,
 subagentFollowUp: true,
 ...(parent.maxRuntimeMs ? { maxRuntimeMs: parent.maxRuntimeMs } : {}),
 }, {
 beforeInsert: () => appendMessage(parent.chatId, {
 id: messageId,
 role: "user",
 content: reviewPrompt,
 }),
 });
 updateChat(parent.chatId, {
 runStatus: "running",
 runUpdatedAt: new Date().toISOString(),
 queueMessage: reviewJob.queueMessage || null,
 badge: null,
 }, parent.userId);
 appendRunEvent(parent.id, parent.chatId, parent.userId, "subagent_review_queued", {
 reviewJobId: reviewJob.id,
 children: asyncChildren.map((child) => ({ jobId: child.id, status: child.status })),
 });
}

function reconcileJobLifecycle(jobId: string) {
 const job = getJob(jobId);
 if (!job || !["completed", "error", "cancelled", "interrupted"].includes(job.status)) return;
 reconcileSubagentParent(job.id);
 if (job.parentJobId) reconcileSubagentParent(job.parentJobId);
  drainPersistedChatQueues();
}

function enqueuePersistedChatFollowUp(chatId: string, userId?: string) {
  if (getActiveJob(chatId, userId)) return null;
  const chat = getChat(chatId, userId);
  const queued = chat?.queuedMessages?.[0];
  const queuedText = queued?.text.trim() || "";
  const queuedAttachments = queued?.attachments || [];
  if (!chat || !queued || (!queuedText && !queuedAttachments.length)) return null;

  let job;
  try {
    job = enqueueJob({
      chatId: chat.id,
      userId: chat.ownerId || userId,
      message: queuedText || (queuedAttachments.length ? "(see attachments)" : ""),
      messageId: queued.id,
      ...(queued.referenceText ? { referenceText: queued.referenceText } : {}),
      ...(queued.references?.length
        ? {
            references: queued.references.map(({ source: _source, ...reference }) => reference),
          }
        : {}),
      ...(chat.agentId ? { agentId: chat.agentId } : {}),
      ...(chat.modelId ? { modelId: chat.modelId } : {}),
      ...(chat.modelParams?.length ? { modelParams: chat.modelParams } : {}),
      ...(chat.sessionState?.modeId ? { modeId: chat.sessionState.modeId } : {}),
      ...(chat.incognito ? { incognito: true } : {}),
      ...(queuedAttachments.length ? { attachments: queuedAttachments } : {}),
    }, {
      beforeInsert: () => {
        const appended = appendMessageInTransaction(chat.id, {
          id: queued.id,
          role: "user",
          content: queuedText || (queuedAttachments.length ? `Attached ${queuedAttachments.length} file${queuedAttachments.length === 1 ? "" : "s"}` : ""),
        ...(queuedAttachments.length ? { attachments: queuedAttachments } : {}),
          ...(queued.referenceText ? { referenceText: queued.referenceText } : {}),
          ...(queued.references?.length ? { references: queued.references } : {}),
        }, chat.ownerId || userId);
        if (!appended) throw new Error("Chat disappeared while draining its queued message.");
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "ActiveChatRun") return null;
    throw error;
  }

  // Remove only after durable enqueue. If this process dies between enqueue and
  // removal, messageId idempotency makes the next drain harmless.
  removeQueuedMessage(chat.id, queued.id, chat.ownerId || userId);
  if (["completed", "cancelled", "error", "interrupted"].includes(job.status)) {
    console.log(`[ai-chat-worker] removed stale queued message ${queued.id}; job ${job.id} is already ${job.status}`);
    return job;
  }
  updateChat(chat.id, {
    runStatus: "running",
    runUpdatedAt: new Date().toISOString(),
    queueMessage: job.queueMessage || null,
    badge: null,
  }, chat.ownerId || userId);
  appendRunEvent(job.id, chat.id, chat.ownerId || userId, "status", {
    status: "queued",
    message: "Queued follow-up accepted by the server and will run in chat order.",
  });
  console.log(`[ai-chat-worker] drained queued chat message ${queued.id} -> ${job.id} (${chat.id})`);
  return job;
}

function drainPersistedChatQueues() {
  for (const chat of listChatsWithQueuedMessages()) {
    try {
      enqueuePersistedChatFollowUp(chat.id, chat.ownerId);
    } catch (error) {
      console.error(`[ai-chat-worker] could not drain queued message for ${chat.id}`, error);
    }
  }
}

function enqueueDueAutomations() {
  for (const automation of claimDueAutomations()) {
    try {
      queueAutomationRun(automation, "scheduled");
    } catch (error) {
      failAutomationClaim(
        automation.id,
        automation.ownerId,
        error instanceof Error ? error.message : "Could not enqueue automation run.",
      );
    }
  }
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

async function main() {
  writeWorkerHeartbeat();
  const heartbeat = setInterval(() => writeWorkerHeartbeat(), 5_000);
  heartbeat.unref();
  for (const expired of reapExpiredJobLeases()) {
    updateChat(expired.chatId, {
      runStatus: "running",
      runUpdatedAt: expired.updatedAt,
      queueMessage: null,
      badge: null,
    }, expired.userId);
    appendRunEvent(expired.id, expired.chatId, expired.userId, "status", {
      status: "recovering",
      message: "Worker lease expired; the run was requeued from its durable checkpoint.",
    });
  }
  const recovered = recoverStaleJobs();
  for (const job of recovered.interrupted) snapshotInterruptedJob(job);
  if (recovered.resumed.length) {
    console.log(`[ai-chat-worker] requeued ${recovered.resumed.length} orphaned run${recovered.resumed.length === 1 ? "" : "s"} after restart`);
  }
  if (recovered.interrupted.length) {
    console.log(`[ai-chat-worker] marked ${recovered.interrupted.length} orphaned run${recovered.interrupted.length === 1 ? "" : "s"} interrupted after restart`);
  }
  console.log(`[ai-chat-worker] started (concurrency: ${Number.isFinite(concurrency) ? concurrency : "unlimited"})`);
  const active = new Set<Promise<void>>();
  let lastQuestionExpiry = 0;
  let lastQueueDrain = 0;
  while (!stopping) {
    enqueueDueAutomations();
    if (Date.now() - lastQueueDrain > 1_000) {
      lastQueueDrain = Date.now();
      drainPersistedChatQueues();
    }
    if (Date.now() - lastQuestionExpiry > 5_000) {
      lastQuestionExpiry = Date.now();
      for (const expired of expirePendingQuestions()) {
        if (!expired) continue;
        if (expired.jobId) updateJob(expired.jobId, { status: "interrupted", error: "The user question expired." });
        updateChat(expired.chatId, {
          runStatus: "interrupted",
          pendingQuestion: null,
          runUpdatedAt: new Date().toISOString(),
          badge: "red",
        });
        if (expired.jobId) appendRunEvent(expired.jobId, expired.chatId, undefined, "status", {
          status: "expired",
          questionId: expired.questionId,
        });
      }
    }
    while (!stopping && active.size < concurrency) {
      const job = claimNextJob({
        // Keep one slot available for a normal interactive chat while
        // background automation/MCP work is already occupying the pool.
        interactiveOnly: Number.isFinite(concurrency) &&
          concurrency > 1 &&
          active.size >= concurrency - 1,
      });
      if (!job) break;
      console.log(`[ai-chat-worker] claimed ${job.id} (${job.chatId})`);
      const task = runJobInIsolatedProcess(job)
        .catch((error) => {
          console.error(`[ai-chat-worker] job ${job.id} failed`, error);
        })
        .finally(() => {
          active.delete(task);
          const current = getJob(job.id);
          if (current?.status === "switching") {
            requeueSwitchingJob(job.id);
          } else if (current && ["completed", "cancelled", "error", "interrupted"].includes(current.status)) {
            finalizeAutomationRunForJob(job.id);
            reconcileJobLifecycle(job.id);
            // Explicit cancellation pauses the user's queued follow-ups. Normal
            // completion or failure advances the FIFO so one broken run cannot
            // strand later change requests.
            if (current.status !== "cancelled") {
              enqueuePersistedChatFollowUp(current.chatId, current.userId);
            }
          }
        });
      active.add(task);
    }
    await waitForSchedulerTick(active, concurrency, pollMs);
  }
  await Promise.all(active);
  clearInterval(heartbeat);
  writeWorkerHeartbeat("stopping");
  console.log("[ai-chat-worker] stopped");
}

main().catch((error) => {
  console.error("[ai-chat-worker] fatal", error);
  process.exitCode = 1;
});
