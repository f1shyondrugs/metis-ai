import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveClaudeAgentContextWindow,
  resolveClaudeAgentModelId,
} from "../lib/providers/claude-context";

test("Claude Code 1M context uses the official [1m] model variant", () => {
  assert.equal(resolveClaudeAgentModelId("claude-opus-5", [{ id: "context", value: "1m" }]), "claude-opus-5[1m]");
  assert.equal(resolveClaudeAgentModelId("claude-sonnet-5", [{ id: "contextWindow", value: "200k" }]), "claude-sonnet-5");
});

test("Claude Code model defaults mirror T3 context choices", () => {
  assert.equal(resolveClaudeAgentModelId("claude-fable-5"), "claude-fable-5[1m]");
  assert.equal(resolveClaudeAgentModelId("claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(resolveClaudeAgentContextWindow("claude-sonnet-5"), 200_000);
  assert.equal(resolveClaudeAgentContextWindow("claude-sonnet-5", [{ id: "context", value: "1m" }]), 1_000_000);
  assert.equal(resolveClaudeAgentContextWindow("claude-opus-4-8"), 1_000_000);
});
