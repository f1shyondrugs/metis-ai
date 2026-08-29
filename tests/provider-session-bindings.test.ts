import assert from "node:assert/strict";
import test from "node:test";
import { providerSessionKey } from "../lib/providers/session-bindings";

test("provider session keys isolate native runtime and connection", () => {
  assert.equal(providerSessionKey("cursor-agent", "c1"), "cursor-agent:c1");
  assert.notEqual(providerSessionKey("cursor-agent", "c1"), providerSessionKey("codex-sdk", "c1"));
  assert.notEqual(providerSessionKey("codex-sdk", "c1"), providerSessionKey("codex-sdk", "c2"));
});
