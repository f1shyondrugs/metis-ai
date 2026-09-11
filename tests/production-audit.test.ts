import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { requestClientAddress } from "../lib/rate-limit";

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
