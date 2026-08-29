import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

const dataDir = path.join(os.tmpdir(), `metis-recovery-${randomUUID()}`);
process.env.CHAT_DATA_DIR = dataDir;
process.env.CHAT_DB_PATH = path.join(dataDir, "chat.sqlite");
process.env.MCP_BEARER_TOKEN = "recovery-test-token";

const modulesPromise = Promise.all([
  import("../lib/db-store"),
  import("../lib/db-jobs"),
  import("../lib/recovery"),
  import("../lib/shared-context"),
]);
let modules!: Awaited<typeof modulesPromise>;

before(async () => {
  modules = await modulesPromise;
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("a live running checkpoint is not treated as restart attention", () => {
  const { createChat } = modules[0];
  const { enqueueJob, updateJob } = modules[1];
  const { resolveRecoverySnapshot } = modules[2];
  const { createSnapshot } = modules[3];
  const chat = createChat("Live run");
  const job = enqueueJob({ chatId: chat.id, message: "go" });
  updateJob(job.id, { status: "running" });
  createSnapshot({
    chatId: chat.id,
    checkpoint: "important",
    runStatus: "running",
    resumeMarker: { jobId: job.id, safe: false, reason: "Agent run was active at checkpoint." },
    availability: "available",
  });
  const resolved = resolveRecoverySnapshot(chat.id);
  assert.equal(resolved?.availability, "available");
  assert.equal(resolved?.runStatus, "running");
  updateJob(job.id, { status: "completed" });
});

test("an interrupted job needs attention until a newer snapshot dismisses it", async () => {
  const { createChat } = modules[0];
  const { enqueueJob, updateJob } = modules[1];
  const { resolveRecoverySnapshot } = modules[2];
  const { createSnapshot } = modules[3];
  const chat = createChat("Interrupted run");
  const job = enqueueJob({ chatId: chat.id, message: "go", agentId: "agent-1" });
  updateJob(job.id, { status: "interrupted", error: "Run interrupted by a worker restart; manual resume is required." });
  const resolved = resolveRecoverySnapshot(chat.id);
  assert.equal(resolved?.availability, "needs_attention");
  assert.equal(resolved?.resumeMarker?.jobId, job.id);
  assert.equal(resolved?.resumeMarker?.safe, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  createSnapshot({
    chatId: chat.id,
    checkpoint: "recovery",
    runStatus: "idle",
    resumeMarker: { safe: true, reason: "Interrupted run dismissed." },
    availability: "available",
  });
  assert.equal(resolveRecoverySnapshot(chat.id)?.availability, "available");
});

test("stale running snapshots without a live job do not keep the banner", () => {
  const { createChat } = modules[0];
  const { resolveRecoverySnapshot } = modules[2];
  const { createSnapshot } = modules[3];
  const chat = createChat("Stale snapshot");
  createSnapshot({
    chatId: chat.id,
    checkpoint: "important",
    runStatus: "running",
    resumeMarker: { safe: false, reason: "Agent run was active at checkpoint." },
    availability: "available",
  });
  const resolved = resolveRecoverySnapshot(chat.id);
  assert.equal(resolved?.availability, "available");
  assert.equal(resolved?.runStatus, "idle");
});

test("worker restart recovery requeues orphaned running jobs", () => {
  const { createChat } = modules[0];
  const { enqueueJob, updateJob, recoverStaleJobs, getJob } = modules[1];
  const { resolveRecoverySnapshot } = modules[2];
  const chat = createChat("Orphan");
  const job = enqueueJob({ chatId: chat.id, message: "go" });
  updateJob(job.id, { status: "running" });
  const recovered = recoverStaleJobs(0);
  assert.ok(recovered.resumed.some((item) => item.id === job.id));
  assert.equal(getJob(job.id)?.status, "queued");
  assert.match(getJob(job.id)?.resumePrompt || "", /Continue from the last saved/);
  assert.equal(resolveRecoverySnapshot(chat.id)?.availability, "available");
  updateJob(job.id, { status: "completed" });
});

test("periodic snapshots reuse one row and ignore unknown owner ids", () => {
  const { createChat } = modules[0];
  const { createSnapshot, getLatestSnapshot } = modules[3];
  const chat = createChat("Recovery owner");
  const first = createSnapshot({
    chatId: chat.id,
    ownerId: "missing-user",
    checkpoint: "periodic",
    runStatus: "idle",
    availability: "available",
  });
  const second = createSnapshot({
    chatId: chat.id,
    ownerId: "missing-user",
    checkpoint: "periodic",
    runStatus: "running",
    availability: "available",
  });
  assert.equal(second.id, first.id);
  assert.equal(getLatestSnapshot(chat.id)?.runStatus, "running");
});

test("enqueue is idempotent by message id and never duplicates the chat message", () => {
  const { createChat, getChat, appendMessageInTransaction } = modules[0];
  const { enqueueJob, updateJob } = modules[1];
  const chat = createChat("Idempotent submit");
  const messageId = `u-${randomUUID()}`;
  const input = { chatId: chat.id, message: "hello", messageId };
  const beforeInsert = () => {
    appendMessageInTransaction(chat.id, { id: messageId, role: "user", content: "hello" });
  };
  const first = enqueueJob(input, { beforeInsert });
  const retry = enqueueJob(input, { beforeInsert });
  assert.equal(retry.id, first.id);
  assert.equal(getChat(chat.id)?.messages.filter((message) => message.id === messageId).length, 1);
  updateJob(first.id, { status: "completed" });
});

test("active-run rejection does not execute submission side effects", () => {
  const { createChat, getChat, appendMessageInTransaction } = modules[0];
  const { enqueueJob, updateJob } = modules[1];
  const chat = createChat("Atomic submit");
  const active = enqueueJob({ chatId: chat.id, message: "first", messageId: `u-${randomUUID()}` });
  const secondId = `u-${randomUUID()}`;
  assert.throws(
    () => enqueueJob(
      { chatId: chat.id, message: "second", messageId: secondId },
      {
        beforeInsert: () => {
          appendMessageInTransaction(chat.id, { id: secondId, role: "user", content: "second" });
        },
      },
    ),
    (error: unknown) => error instanceof Error && error.name === "ActiveChatRun",
  );
  assert.equal(getChat(chat.id)?.messages.some((message) => message.id === secondId), false);
  updateJob(active.id, { status: "completed" });
});

test("a second chat can start immediately while a worker slot is free", () => {
  process.env.AI_CHAT_WORKER_CONCURRENCY = "2";
  const { createChat } = modules[0];
  const { enqueueJob } = modules[1];
  const first = enqueueJob({ chatId: createChat("Slot one").id, message: "one" });
  const second = enqueueJob({ chatId: createChat("Slot two").id, message: "two" });
  assert.equal(first.queueMessage, undefined);
  assert.equal(second.queueMessage, undefined);
});

test("claimNextJob skips an unreadable queued row instead of stalling the queue", async () => {
  const { createChat } = modules[0];
  const { enqueueJob, claimNextJob, getJob } = modules[1];
  const { getDatabase } = await import("../lib/sqlite");
  const blocked = enqueueJob({ chatId: createChat("Corrupt").id, message: "blocked" });
  const next = enqueueJob({ chatId: createChat("Healthy").id, message: "healthy" });
  getDatabase().prepare("UPDATE jobs SET data = ? WHERE id = ?").run("{not-json", blocked.id);
  const claimedIds: string[] = [];
  let claimed = claimNextJob();
  while (claimed && claimed.id !== next.id && claimedIds.length < 100) {
    claimedIds.push(claimed.id);
    claimed = claimNextJob();
  }
  assert.equal(claimed?.id, next.id);
  assert.equal(claimedIds.includes(blocked.id), false);
  assert.equal(getJob(blocked.id)?.status, "error");
});

test("interactive jobs outrank background jobs and reserved slots skip background work", () => {
  const { createChat } = modules[0];
  const { enqueueJob, claimNextJob, updateJob } = modules[1];
  const background = enqueueJob({
    chatId: createChat("Background priority").id,
    message: "background",
    workload: "background",
    priority: 10,
  });
  const interactive = enqueueJob({
    chatId: createChat("Interactive priority").id,
    message: "interactive",
    workload: "interactive",
    priority: 100,
  });
  assert.equal(claimNextJob({ interactiveOnly: true })?.id, interactive.id);
  updateJob(interactive.id, { status: "completed" });
  assert.equal(claimNextJob()?.id, background.id);
  updateJob(background.id, { status: "completed" });
});

test("job transitions are explicit and revisions advance monotonically", () => {
  const { createChat } = modules[0];
  const { enqueueJob, claimNextJob, getJob, updateJob, canTransitionJobStatus } = modules[1];
  const job = enqueueJob({ chatId: createChat("State machine").id, message: "run" });
  assert.equal(job.revision, 0);
  assert.equal(canTransitionJobStatus("queued", "running"), true);
  assert.equal(canTransitionJobStatus("completed", "running"), false);
  let claimed = claimNextJob();
  while (claimed && claimed.id !== job.id) {
    updateJob(claimed.id, { status: "completed" });
    claimed = claimNextJob();
  }
  assert.equal(claimed?.id, job.id);
  assert.equal(claimed?.revision, 1);
  const completed = updateJob(job.id, { status: "completed" });
  assert.equal(completed?.revision, 2);
  assert.throws(
    () => updateJob(job.id, { status: "running" }),
    /Invalid job state transition: completed -> running/,
  );
  assert.equal(getJob(job.id)?.status, "completed");
});

test("stale job writers are rejected by the durable revision check", () => {
  const { createChat } = modules[0];
  const { enqueueJob, claimNextJob, getJob, updateJob } = modules[1];
  const job = enqueueJob({ chatId: createChat("Stale writer").id, message: "run" });
  let claimed = claimNextJob();
  while (claimed && claimed.id !== job.id) {
    updateJob(claimed.id, { status: "completed" });
    claimed = claimNextJob();
  }
  assert.equal(claimed?.id, job.id);
  const expectedRevision = claimed?.revision;
  const heartbeat = updateJob(job.id, { error: "newer state" });
  assert.ok(heartbeat);
  assert.equal(
    updateJob(job.id, { error: "stale overwrite" }, { expectedRevision }),
    null,
  );
  assert.equal(getJob(job.id)?.error, "newer state");
});

test("same model and params clear a stale pending model switch", () => {
  const { createChat } = modules[0];
  const { claimNextJob, enqueueJob, getJob, requestJobModelSwitch, updateJob } = modules[1];
  const chat = createChat("Same model switch");
  const modelId = "antigravity:model-a";
  const params = [{ id: "effort", value: "medium" }];
  const job = enqueueJob({ chatId: chat.id, message: "run", modelId, modelParams: params });
  let claimed = claimNextJob();
  while (claimed && claimed.id !== job.id) {
    updateJob(claimed.id, { status: "completed" });
    claimed = claimNextJob();
  }
  assert.equal(claimed?.id, job.id);
  assert.ok(updateJob(job.id, {
    pendingModelId: modelId,
    pendingModelParams: params,
    modelSwitchRequestedAt: new Date().toISOString(),
  }));
  const resolved = requestJobModelSwitch(chat.id, undefined, modelId, params);
  assert.equal(resolved?.pendingModelId, undefined);
  assert.equal(resolved?.pendingModelParams, undefined);
  assert.equal(resolved?.modelSwitchRequestedAt, undefined);
  assert.equal(getJob(job.id)?.status, "running");
  updateJob(job.id, { status: "completed" });
});

test("worker leases fence stale processes, events, and expired claims", async () => {
  const { createChat } = modules[0];
  const { appendRunEvent, enqueueJob, claimNextJob, getJob, reapExpiredJobLeases, touchJob, updateJob } = modules[1];
  const { appendMessage, createChat: createProjectionChat, updateChat, upsertMessage } = modules[0];
  const { getDatabase } = await import("../lib/sqlite");
  const job = enqueueJob({ chatId: createChat("Lease fencing").id, message: "run" });
  let claimed = claimNextJob({ workerId: "worker-a", leaseMs: 60_000 });
  while (claimed && claimed.id !== job.id) {
    updateJob(claimed.id, { status: "completed" });
    claimed = claimNextJob({ workerId: "worker-a", leaseMs: 60_000 });
  }
  assert.equal(claimed?.id, job.id);
  assert.equal(typeof claimed?.leaseToken, "string");
  assert.equal(getJob(job.id)?.leaseToken, undefined, "lease tokens must not be persisted in job JSON");

  const previousWorker = process.env.AI_CHAT_WORKER_ID;
  const previousToken = process.env.AI_CHAT_JOB_LEASE_TOKEN;
  const previousJob = process.env.AI_CHAT_JOB_ID;
  const { internalRunLeaseAuthorized } = await import("../lib/internal-run-lease");
  try {
    process.env.AI_CHAT_WORKER_ID = "worker-a";
    process.env.AI_CHAT_JOB_LEASE_TOKEN = claimed?.leaseToken;
    process.env.AI_CHAT_JOB_ID = job.id;
    assert.equal(internalRunLeaseAuthorized(new Request("http://localhost", {
      headers: {
        "x-ai-chat-worker-id": "worker-a",
        "x-ai-chat-lease-token": claimed?.leaseToken || "",
      },
    }), job.id), true);
    assert.ok(touchJob(job.id));
    assert.equal(appendRunEvent(job.id, job.chatId, undefined, "status", { status: "running" }).persisted, true);
    assert.ok(updateChat(job.chatId, { badge: "blue" }));
    assert.ok(appendMessage(job.chatId, { role: "assistant", content: "owned" }));
    assert.ok(upsertMessage(job.chatId, { id: "owned-message", role: "assistant", content: "owned" }));
    process.env.AI_CHAT_JOB_LEASE_TOKEN = "stale-token";
    assert.equal(internalRunLeaseAuthorized(new Request("http://localhost", {
      headers: {
        "x-ai-chat-worker-id": "worker-a",
        "x-ai-chat-lease-token": "stale-token",
      },
    }), job.id), false);
    assert.equal(updateJob(job.id, { error: "stale worker write" }), null);
    assert.equal(
      appendRunEvent(job.id, job.chatId, undefined, "text", { text: "stale" }).dropped,
      "stale_lease",
    );
    assert.equal(updateChat(job.chatId, { badge: "red" }), null);
    assert.equal(appendMessage(job.chatId, { role: "assistant", content: "stale" }), null);
    assert.equal(upsertMessage(job.chatId, { id: "stale-message", role: "assistant", content: "stale" }), null);
    assert.throws(
      () => createProjectionChat("stale projection"),
      /Stale worker lease/i,
    );

    process.env.AI_CHAT_JOB_LEASE_TOKEN = claimed?.leaseToken;
    getDatabase().prepare("UPDATE job_leases SET expires_at = ? WHERE job_id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), job.id);
    const requeued = reapExpiredJobLeases();
    assert.equal(requeued.some((item) => item.id === job.id), true);
    assert.equal(getJob(job.id)?.status, "queued");
  } finally {
    if (previousWorker === undefined) delete process.env.AI_CHAT_WORKER_ID;
    else process.env.AI_CHAT_WORKER_ID = previousWorker;
    if (previousToken === undefined) delete process.env.AI_CHAT_JOB_LEASE_TOKEN;
    else process.env.AI_CHAT_JOB_LEASE_TOKEN = previousToken;
    if (previousJob === undefined) delete process.env.AI_CHAT_JOB_ID;
    else process.env.AI_CHAT_JOB_ID = previousJob;
  }
});
