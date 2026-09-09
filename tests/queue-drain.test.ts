import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after, before } from "node:test";

const dataDir = path.join(os.tmpdir(), `metis-queue-drain-${randomUUID()}`);
process.env.CHAT_DATA_DIR = dataDir;
process.env.CHAT_DB_PATH = path.join(dataDir, "chat.sqlite");
process.env.MCP_BEARER_TOKEN = "queue-drain-test-token";

const modulesPromise = Promise.all([
  import("../lib/db-store"),
  import("../lib/db-jobs"),
]);
let modules!: Awaited<typeof modulesPromise>;

before(async () => {
  modules = await modulesPromise;
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("drainNextQueuedMessage turns an idle queued follow-up into a job", () => {
  const { createChat, getChat, updateChat } = modules[0];
  const { drainNextQueuedMessage } = modules[1];
  const chat = createChat("Queue drain idle");
  const queuedId = randomUUID();
  updateChat(chat.id, {
    queuedMessages: [{ id: queuedId, text: "please continue" }],
  });
  const job = drainNextQueuedMessage(chat.id);
  assert.ok(job);
  assert.equal(job.chatId, chat.id);
  assert.equal(job.message, "please continue");
  assert.equal(job.messageId, queuedId);
  const next = getChat(chat.id);
  assert.equal(next?.queuedMessages, undefined);
  assert.equal(next?.runStatus, "running");
  assert.equal(next?.messages.at(-1)?.id, queuedId);
});

test("drainNextQueuedMessage does not steal a chat that already has a run", () => {
  const { createChat, getChat, updateChat } = modules[0];
  const { enqueueJob, updateJob, drainNextQueuedMessage } = modules[1];
  const chat = createChat("Queue drain busy");
  const active = enqueueJob({ chatId: chat.id, message: "already running" });
  updateJob(active.id, { status: "running" });
  updateChat(chat.id, {
    queuedMessages: [{ id: randomUUID(), text: "follow-up later" }],
  });
  assert.throws(
    () => drainNextQueuedMessage(chat.id),
    (error: unknown) => error instanceof Error && error.name === "ActiveChatRun",
  );
  const next = getChat(chat.id);
  assert.equal(next?.queuedMessages?.length, 1);
  assert.equal(next?.queuedMessages?.[0]?.text, "follow-up later");
});

test("drainNextQueuedMessage keeps later follow-ups queued until the first job finishes", () => {
  const { createChat, getChat, updateChat } = modules[0];
  const { drainNextQueuedMessage } = modules[1];
  const chat = createChat("Queue drain serial");
  const firstId = randomUUID();
  const secondId = randomUUID();
  updateChat(chat.id, {
    queuedMessages: [
      { id: firstId, text: "first follow-up" },
      { id: secondId, text: "second follow-up" },
    ],
  });
  const first = drainNextQueuedMessage(chat.id);
  assert.ok(first);
  assert.equal(first.message, "first follow-up");
  assert.throws(
    () => drainNextQueuedMessage(chat.id),
    (error: unknown) => error instanceof Error && error.name === "ActiveChatRun",
  );
  const next = getChat(chat.id);
  assert.equal(next?.queuedMessages?.length, 1);
  assert.equal(next?.queuedMessages?.[0]?.id, secondId);
});

test("claimNextJob does not start a second parent run for the same chat", async () => {
  const { createChat } = modules[0];
  const { enqueueJob, updateJob, claimNextJob } = modules[1];
  const { getDatabase } = await import("../lib/sqlite");
  const chat = createChat("Queue drain claim lock");
  const first = enqueueJob({ chatId: chat.id, message: "already running" });
  updateJob(first.id, { status: "running" });
  const leakedId = randomUUID();
  const now = new Date().toISOString();
  getDatabase()
    .prepare("INSERT INTO jobs (id, chat_id, user_id, data, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      leakedId,
      chat.id,
      null,
      JSON.stringify({
        id: leakedId,
        chatId: chat.id,
        message: "should wait",
        status: "queued",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      }),
      "queued",
      now,
    );
  for (let i = 0; i < 8; i++) {
    const claimed = claimNextJob();
    if (!claimed) break;
    assert.notEqual(claimed.id, leakedId);
    assert.notEqual(claimed.chatId, chat.id);
    updateJob(claimed.id, { status: "completed" });
  }
  assert.equal(claimNextJob(), null);
});

test("the worker scheduler polls persisted chat queues", () => {
  const worker = readFileSync(new URL("../worker.ts", import.meta.url), "utf8");
  assert.match(worker, /function drainPersistedChatQueues\(\)/);
  assert.match(worker, /drainNextQueuedMessage\(chatId, userId\)/);
  assert.match(worker, /error\.name === "ActiveChatRun"/);
  assert.match(worker, /if \(Date\.now\(\) - lastQueueDrain > 1_000\)/);
});
