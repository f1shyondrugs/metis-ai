import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "metis-remote-approval-"));
process.env.CHAT_DATA_DIR = dataDir;
process.env.CHAT_DB_PATH = path.join(dataDir, "chat.sqlite");
process.env.AGENT_CWD = dataDir;
process.env.AI_CHAT_ROOT = dataDir;

test("new remote clients default to user access and deny escalation", async () => {
  const { createUser } = await import("../lib/auth");
  const { authorizeRemoteAction, createEnrollmentToken, registerRemoteClient } = await import("../lib/remote-clients");
  const owner = createUser("remote-owner", "password");
  const registered = registerRemoteClient(createEnrollmentToken(owner.id).token, { name: "test-client" });
  assert.ok(registered?.client);
  assert.equal(registered.client.permissionMode, "user");
  assert.equal(registered.client.policy.mode, "approval_required");
  assert.equal(authorizeRemoteAction(registered.client, "execute_command", "rm -rf /").allowed, false);
  assert.equal(authorizeRemoteAction(registered.client, "write_file").allowed, false);
});

test("admin clients require approval for risky actions", async () => {
  const { createUser } = await import("../lib/auth");
  const { authorizeRemoteAction, createEnrollmentToken, getRemoteClient, registerRemoteClient } = await import("../lib/remote-clients");
  const { getDatabase } = await import("../lib/sqlite");
  const owner = createUser("remote-admin", "password");
  const registered = registerRemoteClient(createEnrollmentToken(owner.id).token, { name: "admin-client", permissionMode: "admin" });
  assert.ok(registered?.client);
  getDatabase().prepare("UPDATE remote_clients SET policy = ? WHERE id = ?").run(JSON.stringify({ mode: "full_access", allowlist: [] }), registered.client.id);
  const client = getRemoteClient(registered.client.id, owner.id);
  assert.ok(client);
  assert.equal(client.permissionMode, "admin");
  assert.equal(authorizeRemoteAction(client, "delete_file").requiresApproval, true);
  assert.equal(authorizeRemoteAction(client, "delete_file").allowed, true);
});

test("remote MCP schema does not expose model-controlled approval", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(path.join(process.cwd(), "lib/mcp-core/gateway-core.mjs"), "utf8");
  assert.doesNotMatch(source, /args\.approved|approved: true/);
});
