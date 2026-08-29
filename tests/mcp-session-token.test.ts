import assert from "node:assert/strict";
import test from "node:test";
import { signTrustedMcpSession, verifyTrustedMcpSession } from "../lib/mcp-core/session-token.mjs";

const secret = "a".repeat(64);
const now = 1_800_000_000_000;
const claims = {
  v: 1 as const,
  exp: now + 60_000,
  userId: "user-a",
  chatId: "chat-a",
  jobId: "job-a",
  workerId: "worker-a",
  leaseToken: "lease-a",
  uid: 1000,
  gid: 1000,
  workspaceRoot: "/home/user-a/workspace",
  home: "/home/user-a",
  modeId: "agent",
  trustedInternal: true as const,
};

test("trusted MCP session token round-trips exact scoped claims", () => {
  const token = signTrustedMcpSession(claims, secret);
  assert.match(token, /^metis-v1\./);
  assert.deepEqual(verifyTrustedMcpSession(token, secret, now), claims);
});

test("trusted MCP session token fails closed on tamper, wrong secret, and expiry", () => {
  const token = signTrustedMcpSession(claims, secret);
  assert.equal(verifyTrustedMcpSession(`${token}x`, secret, now), null);
  assert.equal(verifyTrustedMcpSession(token, "b".repeat(64), now), null);
  assert.equal(verifyTrustedMcpSession(token, secret, claims.exp + 1), null);
});
