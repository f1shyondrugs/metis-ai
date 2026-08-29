import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

const dataDir = path.join(os.tmpdir(), `metis-automations-${randomUUID()}`);
process.env.CHAT_DATA_DIR = dataDir;
process.env.CHAT_DB_PATH = path.join(dataDir, "chat.sqlite");
process.env.MCP_BEARER_TOKEN = "automation-test-token";

const modulesPromise = Promise.all([
  import("../lib/auth"),
  import("../lib/db-store"),
  import("../lib/automations"),
  import("../lib/db-jobs"),
  import("../lib/sqlite"),
]);
let modules!: Awaited<typeof modulesPromise>;

before(async () => {
  modules = await modulesPromise;
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("automation runs are isolated, durable, tool-capable jobs with long runtime limits", () => {
  const { createUser } = modules[0];
  const { appendMessage, createChat, getChat, listChatsForUser, updateChat } = modules[1];
  const {
    claimDueAutomations,
    createAutomation,
    deleteAutomation,
    finalizeAutomationRunForJob,
    getAutomation,
    queueAutomationRun,
  } = modules[2];
  const { getJob, updateJob } = modules[3];
  const { getDatabase } = modules[4];

  const user = createUser("automation-owner", "test-password");
  const contextChat = createChat("Automation context", {
    tabs: [{ id: "tab-1", title: "Initial", url: "https://example.com" }],
    activeTabId: "tab-1",
    sessionKey: "automation-browser-session",
    updatedAt: new Date().toISOString(),
  }, user.id);

  appendMessage(contextChat.id, { role: "user", content: "Use the existing signed-in browser session for this automation." }, user.id);

  const automation = createAutomation({
    ownerId: user.id,
    chatId: contextChat.id,
    name: "Long browser task",
    prompt: "Use the browser and MCP tools to complete the task.",
    creator: "user",
    maxRunMinutes: 3 * 24 * 60,
    schedule: { kind: "interval", everyMinutes: 60 },
    timezone: "Europe/Berlin",
  });

  assert.equal(automation.modeId, "agent");
  assert.equal(automation.projectId, undefined);
  assert.equal(automation.maxRunMinutes, 4320);
  assert.deepEqual(automation.graph.nodes.map((node) => node.kind), ["trigger", "agent", "tools"]);
  assert.equal(automation.graph.nodes.at(-1)?.config?.browser, true);
  assert.equal(automation.graph.nodes.at(-1)?.config?.mcp, "all");

  const queued = queueAutomationRun(automation, "manual");
  const job = getJob(queued.job.id);
  assert.equal(job?.maxRuntimeMs, 4320 * 60_000);
  assert.equal(job?.modeId, "agent");
  assert.equal(job?.automationId, automation.id);
  assert.match(job?.automationContext || "", /existing signed-in browser session/);

  const runChat = getChat(queued.run.chatId, user.id);
  assert.ok(runChat);
  assert.notEqual(runChat?.id, contextChat.id);
  assert.equal(runChat?.automationId, automation.id);
  assert.equal(runChat?.automationRunId, queued.run.id);
  assert.equal(runChat?.browserContext?.sessionKey, "automation-browser-session");
  assert.equal(runChat?.messages[0]?.content, automation.prompt);

  const normalChatIds = listChatsForUser(user.id).map((chat) => chat.id);
  assert.ok(normalChatIds.includes(contextChat.id));
  assert.ok(!normalChatIds.includes(queued.run.chatId), "run chats stay out of the normal sidebar index");

  // Even if the schedule becomes overdue, a long active run must never be claimed a second time.
  getDatabase().prepare(
    "UPDATE automations SET next_run_at = ?, claimed_at = NULL WHERE id = ?",
  ).run(new Date(Date.now() - 60_000).toISOString(), automation.id);
  assert.equal(claimDueAutomations().some((item) => item.id === automation.id), false);

  updateChat(queued.run.chatId, {
    browserContext: {
      tabs: [{ id: "tab-2", title: "Finished", url: "https://example.com/finished" }],
      activeTabId: "tab-2",
      sessionKey: "automation-browser-session",
      updatedAt: new Date().toISOString(),
    },
  }, user.id);
  appendMessage(queued.run.chatId, { role: "assistant", content: "Task completed with browser + MCP tools." }, user.id);
  updateJob(queued.job.id, { status: "completed" });
  finalizeAutomationRunForJob(queued.job.id);

  const completed = getAutomation(automation.id, user.id);
  assert.equal(completed?.status, "active");
  assert.equal(completed?.runs?.[0]?.status, "completed");
  assert.match(completed?.runs?.[0]?.resultPreview || "", /Task completed/);
  assert.equal(getChat(contextChat.id, user.id)?.browserContext?.activeTabId, "tab-2", "browser state carries forward to the next isolated run");

  assert.equal(deleteAutomation(automation.id, user.id), true);
  assert.equal(getChat(queued.run.chatId, user.id), null, "deleting an automation removes its auxiliary run chats");
  assert.ok(getChat(contextChat.id, user.id), "the user-selected context chat is preserved");
});
