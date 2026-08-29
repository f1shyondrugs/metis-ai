import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";

import type { ToolPermissionCategory } from "@/lib/store";

import {
  approvalPatternFor,
  DEFAULT_RUNTIME_MODE,
  normalizeRuntimeMode,
  RUNTIME_MODES,
  RUNTIME_MODE_TO_CLAUDE_PERMISSION,
  RUNTIME_MODE_TO_CODEX,
  runtimeModeForChat,
  runtimeModeRequiresApproval,
  shouldAutoApprove,
} from "../lib/runtime-mode";

const dataDir = path.join(os.tmpdir(), `metis-runtime-mode-${randomUUID()}`);
process.env.CHAT_DATA_DIR = dataDir;
process.env.CHAT_DB_PATH = path.join(dataDir, "chat.sqlite");
process.env.AGENT_CWD = dataDir;
process.env.AI_CHAT_ROOT = dataDir;
process.env.AI_CHAT_INTERNAL_ORIGIN ||= "http://127.0.0.1:1";

const modulesPromise = Promise.all([
  import("../lib/db-approvals"),
  import("../lib/db-store"),
]);

let modules!: Awaited<typeof modulesPromise>;

before(async () => {
  modules = await modulesPromise;
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("normalizeRuntimeMode accepts only the complete runtime mode set", () => {
  for (const mode of RUNTIME_MODES)
    assert.equal(normalizeRuntimeMode(mode), mode);
  assert.equal(normalizeRuntimeMode("unknown"), DEFAULT_RUNTIME_MODE);
  assert.equal(normalizeRuntimeMode(undefined), DEFAULT_RUNTIME_MODE);
  assert.equal(normalizeRuntimeMode(42), DEFAULT_RUNTIME_MODE);
  assert.equal(runtimeModeForChat({ runtimeMode: "auto" }), "auto");
  assert.equal(runtimeModeForChat({ runtimeMode: null }), DEFAULT_RUNTIME_MODE);
});

test("every runtime mode has complete provider mappings", () => {
  assert.deepEqual(
    RUNTIME_MODES.map((mode) => RUNTIME_MODE_TO_CODEX[mode]?.sandboxMode),
    ["read-only", "workspace-write", "workspace-write", "danger-full-access"],
  );
  assert.deepEqual(
    RUNTIME_MODES.map((mode) => RUNTIME_MODE_TO_CODEX[mode]?.approvalPolicy),
    ["untrusted", "on-request", "on-request", "never"],
  );
  assert.deepEqual(
    RUNTIME_MODES.map(
      (mode) => RUNTIME_MODE_TO_CLAUDE_PERMISSION[mode]?.permissionMode,
    ),
    ["default", "acceptEdits", "acceptEdits", "bypassPermissions"],
  );
  assert.deepEqual(
    RUNTIME_MODES.map(
      (mode) => RUNTIME_MODE_TO_CLAUDE_PERMISSION[mode]?.canUseToolRequired,
    ),
    [true, false, false, false],
  );
  for (const mode of RUNTIME_MODES) {
    assert.ok(RUNTIME_MODE_TO_CODEX[mode]);
    assert.ok(RUNTIME_MODE_TO_CLAUDE_PERMISSION[mode]);
  }
});

test("approvals round-trip and cannot be resolved twice", async () => {
  const {
    createApproval,
    expireApproval,
    getApproval,
    heartbeatApproval,
    resolveApproval,
  } = modules[0];
  const { createChat } = modules[1];
  const chat = createChat("Runtime approval");
  const { approvalId } = createApproval({
    jobId: "job-1",
    chatId: chat.id,
    title: "Command approval required",
    command: "pnpm test",
  });
  assert.ok(heartbeatApproval(approvalId));
  const pending = getApproval(approvalId);
  assert.equal(pending?.status, "waiting_for_user");
  const resolved = resolveApproval(approvalId, "allow");
  assert.equal(resolved?.chatId, chat.id);
  assert.equal(getApproval(approvalId)?.status, "resolved");
  assert.equal(getApproval(approvalId)?.decision, "allow");
  assert.equal(resolveApproval(approvalId, "deny"), null);
  const expired = createApproval({
    jobId: "job-2",
    chatId: chat.id,
    title: "Expiring approval",
  });
  assert.equal(expireApproval(expired.approvalId)?.decision, "deny");
  assert.equal(getApproval(expired.approvalId)?.decision, "deny");
  assert.equal(resolveApproval(expired.approvalId, "allow"), null);
});

test("chat persistence normalizes runtime mode and session approvals keep their canonical scope", async () => {
  const { createApproval, getApproval, resolveApproval } = modules[0];
  const { createChat, getChat, updateChat } = modules[1];
  const chat = createChat("Runtime persistence");
  updateChat(chat.id, { runtimeMode: "not-a-mode" });
  assert.equal(getChat(chat.id)?.runtimeMode, undefined);
  updateChat(chat.id, { runtimeMode: "approval-required" });
  assert.equal(getChat(chat.id)?.runtimeMode, "approval-required");

  const scope = approvalPatternFor("write_file", { path: "/tmp/a/b" });
  const { approvalId } = createApproval({
    chatId: chat.id,
    title: "Write approval",
    sessionScope: scope,
  });
  const resolved = resolveApproval(approvalId, "allow-session");
  assert.equal(resolved?.sessionScope, scope);
  assert.equal(getApproval(approvalId)?.sessionScope, scope);
});

test("session prefix decisions auto-approve only matching tool input prefixes", () => {
  const pattern = approvalPatternFor("execute_command", {
    command: "pnpm test",
  });
  assert.equal(
    shouldAutoApprove([pattern], "execute_command", { command: "pnpm test" }),
    true,
  );
  assert.equal(
    shouldAutoApprove([pattern.slice(0, -1)], "execute_command", {
      command: "pnpm test",
    }),
    true,
  );
  assert.equal(
    shouldAutoApprove([pattern], "execute_command", { command: "npm test" }),
    false,
  );
  assert.equal(
    shouldAutoApprove([pattern], "write_file", { command: "pnpm test" }),
    false,
  );
  assert.equal(
    shouldAutoApprove([], "execute_command", { command: "pnpm test" }),
    false,
  );
});

test("runtime approval gate covers terminal and write tools only in approval mode", async () => {
  assert.equal(
    runtimeModeRequiresApproval("approval-required", "terminal"),
    true,
  );
  assert.equal(runtimeModeRequiresApproval("approval-required", "write"), true);
  assert.equal(runtimeModeRequiresApproval("approval-required", "read"), false);
  assert.equal(runtimeModeRequiresApproval("full-access", "terminal"), false);
  // The package re-exports the same pure gate used by gateway dispatch.
  // @ts-expect-error — untyped .mjs re-export; shapes verified by assertions below.
  const gateway = (await import("../packages/mcp-gateway/index.mjs")) as {
    modeToolCategory: (name: string) => string;
    runtimeModeRequiresApproval: typeof runtimeModeRequiresApproval;
    shouldAutoApprove: typeof shouldAutoApprove;
  };
  assert.equal(gateway.modeToolCategory("execute_command"), "terminal");
  assert.equal(gateway.modeToolCategory("write_file"), "write");
  assert.equal(
    gateway.runtimeModeRequiresApproval(
      "approval-required",
      gateway.modeToolCategory("execute_command") as ToolPermissionCategory,
    ),
    true,
  );
  assert.equal(
    gateway.runtimeModeRequiresApproval(
      "full-access",
      gateway.modeToolCategory("execute_command") as ToolPermissionCategory,
    ),
    false,
  );
  assert.equal(
    gateway.shouldAutoApprove(
      [approvalPatternFor("write_file", { path: "/tmp/a/b" })],
      "execute_command",
      { command: "pnpm test" },
    ),
    false,
  );
  // The gateway's local prefix format is identical to lib/runtime-mode.ts.
  assert.equal(
    gateway.shouldAutoApprove(
      ['write_file:{"path":"/tmp/a/b"}'],
      "write_file",
      { path: "/tmp/a/b" },
    ),
    true,
  );
});
