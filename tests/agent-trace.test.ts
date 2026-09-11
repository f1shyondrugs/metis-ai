import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

const dataDir = path.join(os.tmpdir(), `metis-trace-${randomUUID()}`);
process.env.CHAT_DATA_DIR = dataDir;
process.env.CHAT_DB_PATH = path.join(dataDir, "chat.sqlite");

const modulesPromise = import("../lib/agent-trace");
let modules!: Awaited<typeof modulesPromise>;

before(async () => {
  modules = await modulesPromise;
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("trace redaction strips secrets and truncates huge text", () => {
  const redacted = modules.redactTraceValue({
    authorization: "Bearer secret-token",
    apiKey: "sk-abcdefghijklmnop",
    nested: {
      password: "hunter2",
      ok: "visible",
      args: { command: "export TOKEN=sk-live-testvalue" },
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue1234567890",
      slack: `xoxb-${"0".repeat(12)}-${"a".repeat(24)}`,
      aws: "AKIAIOSFODNN7EXAMPLE",
      hex: "0123456789abcdef0123456789abcdef",
    },
    blob: "x".repeat(9_000),
  }) as Record<string, unknown>;
  assert.equal(redacted.authorization, "[redacted]");
  assert.equal(redacted.apiKey, "[redacted]");
  assert.equal((redacted.nested as { password: string; ok: string }).password, "[redacted]");
  assert.equal((redacted.nested as { password: string; ok: string }).ok, "visible");
  const nested = redacted.nested as Record<string, unknown>;
  assert.equal((nested.args as Record<string, string>).command, "export TOKEN=[redacted]");
  assert.equal(nested.jwt, "[redacted]");
  assert.equal(nested.slack, "[redacted]");
  assert.equal(nested.aws, "[redacted]");
  assert.equal(nested.hex, "[redacted]");
  assert.equal(String(redacted.blob).includes("[truncated"), true);
});

test("appendAgentTrace removes trace days older than 14 days", () => {
  const oldNamedDay = path.join(dataDir, "agent-traces", "2020-01-01");
  const oldMtimeDay = path.join(dataDir, "agent-traces", "legacy");
  mkdirSync(path.join(oldNamedDay), { recursive: true });
  mkdirSync(path.join(oldMtimeDay), { recursive: true });
  const oldTime = new Date("2020-01-01T00:00:00.000Z");
  utimesSync(oldMtimeDay, oldTime, oldTime);
  const job = {
    id: randomUUID(),
    chatId: randomUUID(),
    createdAt: new Date().toISOString(),
    modelId: "cursor:test",
  };
  modules.appendAgentTrace(job, "start", { ok: true });
  assert.equal(existsSync(oldNamedDay), false);
  assert.equal(existsSync(oldMtimeDay), false);
});

test("appendAgentTrace writes jsonl without raw token deltas", () => {
  const job = {
    id: randomUUID(),
    chatId: randomUUID(),
    createdAt: new Date().toISOString(),
    modelId: "cursor:test",
  };
  modules.appendAgentTrace(job, "start", { token: "sk-live-should-hide" });
  modules.appendAgentTrace(job, "text", { text: "hello world from the model" });
  const lines = readFileSync(modules.agentTracePath(job), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const start = JSON.parse(lines[0]);
  const text = JSON.parse(lines[1]);
  assert.equal(start.event, "start");
  assert.equal(start.data.token, "[redacted]");
  assert.equal(text.data.chars, 26);
  assert.equal(text.data.tail, "hello world from the model");
});
