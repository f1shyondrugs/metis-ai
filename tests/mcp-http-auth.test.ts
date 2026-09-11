import assert from "node:assert/strict";
import test from "node:test";
import { signTrustedMcpSession } from "../lib/mcp-core/session-token.mjs";
// @ts-expect-error extracted helper ships as plain ESM without a checked JS graph
import { corsAllowOrigin, corsAllowedOrigins, requestAuthorization } from "../lib/mcp-core/http-auth.mjs";

const secret = "a".repeat(64);
const now = 1_800_000_000_000;

test("localhost without a bearer is rejected", () => {
  const req = {
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.deepEqual(requestAuthorization(req, secret), { ok: false, trustedContext: null });
});

test("static bearer and signed session tokens are accepted", () => {
  const staticReq = { headers: { authorization: `Bearer ${secret}` }, socket: { remoteAddress: "10.0.0.8" } };
  assert.equal(requestAuthorization(staticReq, secret).ok, true);
  assert.equal(requestAuthorization(staticReq, secret).trustedContext, null);

  const token = signTrustedMcpSession({
    v: 1,
    exp: now + 60_000,
    userId: "user-a",
    uid: 1000,
    gid: 1000,
    workspaceRoot: "/tmp",
    home: "/tmp",
    trustedInternal: true,
  }, secret);
  const sessionReq = { headers: { authorization: `Bearer ${token}` }, socket: { remoteAddress: "127.0.0.1" } };
  const auth = requestAuthorization(sessionReq, secret);
  assert.equal(auth.ok, true);
  assert.equal(auth.trustedContext?.userId, "user-a");
});

test("tampered session tokens fail closed instead of localhost anonymous", () => {
  const req = {
    headers: { authorization: "Bearer metis-v1.not-a-token" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal(requestAuthorization(req, secret).ok, false);
});

test("CORS does not reflect arbitrary origins", () => {
  const allowed = corsAllowedOrigins({
    internalOrigin: "https://ai.example.com",
    extra: "https://app.example.com",
  });
  assert.equal(corsAllowOrigin("https://ai.example.com", allowed), "https://ai.example.com");
  assert.equal(corsAllowOrigin("https://evil.example", allowed), null);
  assert.equal(corsAllowOrigin("", allowed), null);
});
