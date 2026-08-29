import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

const dataDir = path.join(os.tmpdir(), `metis-knowledge-${randomUUID()}`);
process.env.CHAT_DATA_DIR = dataDir;
process.env.CHAT_DB_PATH = path.join(dataDir, "chat.sqlite");

const modulesPromise = Promise.all([
  import("../lib/db-store"),
  import("../lib/shared-context"),
  import("../lib/knowledge-lifecycle"),
]);
let modules!: Awaited<typeof modulesPromise>;

before(async () => {
  modules = await modulesPromise;
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("extractor keeps durable preferences/config but drops transient and questions", () => {
  const { extractKnowledgeCandidates } = modules[2];
  const durable = extractKnowledgeCandidates("Ich bevorzuge kurze Antworten. Mein Server hat 256 GB RAM.");
  assert.equal(durable.length, 2);
  assert.ok(durable.every((item) => item.kind === "durable"));
  assert.deepEqual(extractKnowledgeCandidates("Heute brauche ich 256 GB RAM. Wie viel kostet das?"), []);
});

test("extractor keeps scoped project requirements out of global memory", () => {
  const { extractKnowledgeCandidates } = modules[2];
  const [candidate] = extractKnowledgeCandidates("Bei Metis soll Repo-Kontext immer nur on demand geladen werden.");
  assert.equal(candidate?.kind, "task");
  // Long-lived app/project requirements stay task-scoped, not global.
  const [task] = extractKnowledgeCandidates("Die Metis UI soll kompakt bleiben.");
  assert.equal(task?.kind, "task");
});

test("automatic capture is idempotent, updates changed stable facts, and never stores secrets", () => {
  const { createChat, listMemories, getChat } = modules[0];
  const { listNotes } = modules[1];
  const { captureKnowledgeFromUserTurn } = modules[2];
  const chat = createChat("Knowledge lifecycle");

  captureKnowledgeFromUserTurn({ chatId: chat.id, messageId: "m1", message: "Mein Server hat 256 GB RAM. Die Metis UI soll kompakt bleiben." });
  captureKnowledgeFromUserTurn({ chatId: chat.id, messageId: "m1", message: "Mein Server hat 256 GB RAM. Die Metis UI soll kompakt bleiben." });
  assert.equal(listMemories().filter((m) => m.tags?.includes("auto:knowledge")).length, 1);
  assert.equal(listNotes({ chatId: chat.id, scope: "chat" }).filter((n) => n.kind === "learned_fact").length, 1);

  captureKnowledgeFromUserTurn({ chatId: chat.id, messageId: "m2", message: "Mein Server hat 512 GB RAM." });
  const auto = listMemories().filter((m) => m.tags?.includes("auto:knowledge"));
  assert.equal(auto.length, 1);
  assert.match(auto[0].content, /512 GB RAM/);

  captureKnowledgeFromUserTurn({ chatId: chat.id, messageId: "m3", message: "Mein API Key ist abc123 und mein Token ist secret." });
  assert.equal(listMemories().some((m) => /abc123|secret/.test(m.content)), false);
  assert.ok((getChat(chat.id)?.keywords || []).includes("server"));
});
