import { appendRunEvent, getJob, touchJob, updateJob } from "@/lib/db-jobs";
import { updateChat } from "@/lib/db-store";

const HEARTBEAT_MS = 10_000;
const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "switching", "waiting_input", "waiting_for_user"]);
const TERMINAL_JOB_STATUSES = new Set(["cancelled", "interrupted", "error", "completed"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runAgentTimedWait(options: {
  jobId: string;
  chatId: string;
  userId?: string;
  waitMs: number;
  reason?: string;
}): Promise<{ waitedMs: number; waitingUntil: string }> {
  const { jobId, chatId, userId, waitMs, reason } = options;
  const current = getJob(jobId);
  if (!current || !ACTIVE_JOB_STATUSES.has(current.status)) {
    throw new Error("The agent wait was cancelled.");
  }
  if (current.status !== "running") {
    const resumed = updateJob(jobId, { status: "running" });
    if (!resumed || resumed.status !== "running") throw new Error("The agent wait was cancelled.");
  }

  const waitingUntil = new Date(Date.now() + waitMs).toISOString();
  touchJob(jobId);
  appendRunEvent(jobId, chatId, userId, "status", {
    status: "waiting",
    waitingUntil,
    durationMs: waitMs,
    reason,
  });
  updateChat(chatId, {
    runStatus: "running",
    runUpdatedAt: new Date().toISOString(),
  }, userId);

  let remaining = waitMs;
  while (remaining > 0) {
    const job = getJob(jobId);
    if (!job || TERMINAL_JOB_STATUSES.has(job.status)) {
      throw new Error("The agent wait was cancelled.");
    }
    if (job.status !== "running") {
      const resumed = updateJob(jobId, { status: "running" });
      if (!resumed || resumed.status !== "running") throw new Error("The agent wait was cancelled.");
    }
    const slice = Math.min(HEARTBEAT_MS, remaining);
    await sleep(slice);
    remaining -= slice;
    touchJob(jobId);
    appendRunEvent(jobId, chatId, userId, "status", {
      status: "waiting",
      remainingMs: remaining,
      waitingUntil,
    });
  }

  const after = getJob(jobId);
  if (!after || TERMINAL_JOB_STATUSES.has(after.status)) {
    throw new Error("The agent wait was cancelled.");
  }
  if (after.status !== "running") {
    const resumed = updateJob(jobId, { status: "running" });
    if (!resumed || resumed.status !== "running") throw new Error("The agent wait was cancelled.");
  }
  updateChat(chatId, {
    runStatus: "running",
    runUpdatedAt: new Date().toISOString(),
  }, userId);
  appendRunEvent(jobId, chatId, userId, "status", {
    status: "running",
    reason: "Agent wait finished.",
  });
  return { waitedMs: waitMs, waitingUntil };
}
