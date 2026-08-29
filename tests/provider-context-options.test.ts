import assert from "node:assert/strict";
import test from "node:test";
import { anthropicProviderOptionsForSelection, compatibleProviderOptionsForSelection } from "../lib/providers/runner";

test("Anthropic 1M beta is sent only for explicit compatible selections", () => {
  assert.deepEqual(
    anthropicProviderOptionsForSelection("claude-sonnet-4.5", [{ id: "context", value: "1m" }]),
    { anthropic: { anthropicBeta: ["context-1m-2025-08-07"] } },
  );
  assert.equal(
    anthropicProviderOptionsForSelection("claude-sonnet-4.5", [{ id: "context", value: "200k" }]),
    undefined,
  );
  assert.equal(
    anthropicProviderOptionsForSelection("claude-sonnet-4.6", [{ id: "context", value: "1m" }]),
    undefined,
  );
});


test("OpenAI-compatible provider options forward reasoning_effort and keep GLM-5.3 thinking enabled", () => {
  const connection = { id: "zai-1", providerKey: "compatible" };
  assert.deepEqual(
    compatibleProviderOptionsForSelection(connection, "glm-5.3", [{ id: "effort", value: "max" }]),
    {
      "compatible-zai-1": {
        reasoningEffort: "max",
        thinking: { type: "enabled" },
      },
    },
  );
  assert.deepEqual(
    compatibleProviderOptionsForSelection(connection, "glm-5.3", [{ id: "effort", value: "medium" }]),
    {
      "compatible-zai-1": {
        reasoningEffort: "high",
        thinking: { type: "enabled" },
      },
    },
  );
  assert.equal(
    compatibleProviderOptionsForSelection(connection, "custom-model", [{ id: "effort", value: "none" }]),
    undefined,
  );
});
