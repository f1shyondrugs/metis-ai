import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { requestClientAddress } from "../lib/rate-limit";
import { CHAT_LIST_POLL_ACTIVE_MS, CHAT_LIST_POLL_IDLE_MS } from "../lib/chat-list-poll";

const dataDir = path.join(os.tmpdir(), `metis-prod-audit-${randomUUID()}`);
process.env.CHAT_DATA_DIR = dataDir;
process.env.CHAT_DB_PATH = path.join(dataDir, "chat.sqlite");
process.env.AGENT_CWD = dataDir;
process.env.AI_CHAT_ROOT = dataDir;
process.env.CHAT_PASSWORD = "";

const modulesPromise = Promise.all([
  import("../lib/db-store"),
  import("../lib/sqlite"),
]);
let modules!: Awaited<typeof modulesPromise>;

before(async () => {
  modules = await modulesPromise;
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("getChatByShareId looks up by share.id without scanning every chat blob", () => {
  const { createChat, updateChatShare, getChatByShareId } = modules[0];
  const decoy = createChat("Decoy");
  const shared = createChat("Shared");
  const updated = updateChatShare(shared.id, { active: true });
  assert.ok(updated?.share?.id);
  const found = getChatByShareId(updated.share.id);
  assert.equal(found.status, "ok");
  if (found.status === "ok") {
    assert.equal(found.chat.id, shared.id);
    assert.notEqual(found.chat.id, decoy.id);
  }
  assert.equal(getChatByShareId("missing-share").status, "not_found");
});

test("incognito chats are excluded from the normal chat list", () => {
  const { createChat, listChatsForUser } = modules[0];
  const visible = createChat("Visible");
  const hidden = createChat("Secret", undefined, undefined, undefined, { incognito: true });
  const listed = listChatsForUser();
  assert.equal(listed.some((chat) => chat.id === visible.id), true);
  assert.equal(listed.some((chat) => chat.id === hidden.id), false);
});

test("nested transaction() uses a savepoint instead of throwing", () => {
  const { transaction, getDatabase } = modules[1];
  const value = transaction(() => {
    getDatabase().exec("CREATE TABLE IF NOT EXISTS audit_nest (id INTEGER)");
    return transaction(() => {
      getDatabase().prepare("INSERT INTO audit_nest (id) VALUES (?)").run(1);
      return 7;
    });
  });
  assert.equal(value, 7);
  const row = modules[1].getDatabase().prepare("SELECT COUNT(*) AS count FROM audit_nest").get() as { count: number };
  assert.equal(row.count, 1);
});

test("requestClientAddress prefers x-real-ip and otherwise the last XFF hop", () => {
  const spoofed = new Request("http://localhost", {
    headers: {
      "x-forwarded-for": "1.2.3.4, 10.0.0.1",
      "x-real-ip": "10.0.0.1",
    },
  });
  assert.equal(requestClientAddress(spoofed), "10.0.0.1");

  const lastHop = new Request("http://localhost", {
    headers: { "x-forwarded-for": "8.8.8.8, 10.1.1.1" },
  });
  assert.equal(requestClientAddress(lastHop), "10.1.1.1");
});

test("listChatsForUser reads chat_list instead of json_extract on chats.data", () => {
  const src = readFileSync(path.join(import.meta.dirname, "../lib/db-store.ts"), "utf8");
  const start = src.indexOf("export function listChatsForUser");
  const end = src.indexOf("export type ChatSearchResult");
  const fn = src.slice(start, end);
  assert.match(fn, /FROM chat_list/);
  assert.equal(/json_extract\(data/.test(fn), false);
  const { getDatabase } = modules[1];
  const plan = getDatabase()
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT id FROM chat_list
       WHERE owner_id = ? AND incognito = 0 AND (automation_run_id IS NULL OR automation_run_id = '') AND archived = 0`,
    )
    .all("owner-x") as Array<{ detail?: string }>;
  const details = plan.map((row) => row.detail || "").join("\n");
  assert.match(details, /chat_list/);
});

test("archived chats stay out of the default list", () => {
  const { createChat, listChatsForUser, updateChat } = modules[0];
  const open = createChat("Open");
  const archived = createChat("Archived");
  updateChat(archived.id, { archived: true });
  const listed = listChatsForUser();
  assert.equal(listed.some((chat) => chat.id === open.id), true);
  assert.equal(listed.some((chat) => chat.id === archived.id), false);
  assert.equal(
    listChatsForUser(undefined, { includeArchived: true }).some((chat) => chat.id === archived.id),
    true,
  );
});

test("upsertMessage patches one message without dropping list metadata", () => {
  const { appendMessage, createChat, getChat, listChatsForUser, upsertMessage } = modules[0];
  const chat = createChat("Checkpoint");
  appendMessage(chat.id, { role: "user", content: "hello" });
  const assistantId = randomUUID();
  upsertMessage(chat.id, { id: assistantId, role: "assistant", content: "one" });
  upsertMessage(chat.id, { id: assistantId, role: "assistant", content: "one two three" });
  const loaded = getChat(chat.id);
  assert.equal(loaded?.messages.at(-1)?.content, "one two three");
  assert.equal(loaded?.messages.filter((item) => item.id === assistantId).length, 1);
  assert.equal(listChatsForUser().find((item) => item.id === chat.id)?.title, "Checkpoint");
});

test("chat list poll is 30s idle and 10s while a run is active", () => {
  assert.equal(CHAT_LIST_POLL_IDLE_MS, 30_000);
  assert.equal(CHAT_LIST_POLL_ACTIVE_MS, 10_000);
  const src = readFileSync(path.join(import.meta.dirname, "../components/app-shell.tsx"), "utf8");
  assert.match(src, /CHAT_LIST_POLL_IDLE_MS/);
  assert.match(src, /document\.visibilityState === "hidden"/);
  assert.equal(/setInterval\(\(\) => void loadChats\(\), 10000\)/.test(src), false);
});

test("production mutating internal routes require the active run lease", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousToken = process.env.MCP_BEARER_TOKEN;
  process.env.NODE_ENV = "production";
  process.env.MCP_BEARER_TOKEN = "production-audit-token";
  try {
    const { POST } = await import("../app/api/internal/mcp-file/route");
    const response = await POST(new Request("http://localhost/api/internal/mcp-file", {
      method: "POST",
      headers: {
        authorization: "Bearer production-audit-token",
        "x-ai-chat-id": "chat-id",
        "x-ai-chat-job-id": "job-id",
      },
      body: JSON.stringify({ path: "file.txt" }),
    }));
    assert.equal(response.status, 401);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousToken === undefined) delete process.env.MCP_BEARER_TOKEN;
    else process.env.MCP_BEARER_TOKEN = previousToken;
  }
});
