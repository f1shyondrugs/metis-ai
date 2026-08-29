import assert from "node:assert/strict";
import test from "node:test";
import {
  contextPressure,
  contextWindowForModel,
  contextWindowForSelection,
  contextWindowOf,
  estimateContextTokens,
  inferContextWindow,
  resolveContextTotal,
  formatContextWindow,
  lastMeasuredInputTokens,
} from "../lib/context-window";

test("contextWindowOf reads nested provider fields", () => {
  assert.equal(contextWindowOf({ max_input_tokens: 200_000 }), 200_000);
  assert.equal(contextWindowOf({ metadata: { context_window: 1_048_576 } }), 1_048_576);
  assert.equal(contextWindowOf({ contextWindow: 0 }), undefined);
  assert.equal(contextWindowOf({ top_provider: { context_length: 202_752 } }), 202_752);
  assert.equal(contextWindowOf({ inputTokenLimit: "1048576" }), 1_048_576);
  assert.equal(contextWindowOf({ max_model_len: "200K" }), 200_000);
  assert.equal(contextWindowOf({ max_tokens: 4096 }), undefined);
});

test("inferContextWindow covers grok and gemini instead of a fake 128k cap", () => {
  assert.equal(inferContextWindow("cursor:grok-4.6"), 2_000_000);
  assert.equal(inferContextWindow("google:gemini-2.5-pro"), 1_048_576);
  assert.equal(inferContextWindow("anthropic:claude-sonnet-4-6"), 200_000);
  assert.equal(inferContextWindow("grok-3-mini"), 131_072);
  assert.equal(inferContextWindow("gpt-5"), 400_000);
  assert.equal(inferContextWindow("zai:conn:glm-4.5"), 128_000);
  assert.equal(inferContextWindow("zai:conn:glm-4.6"), 200_000);
  assert.equal(inferContextWindow("zai:conn:glm-5.2"), 200_000);
});

test("resolveContextTotal keeps the reported maximum when usage overflows", () => {
  assert.equal(resolveContextTotal(128_000, 445_000), 128_000);
  assert.equal(resolveContextTotal(2_000_000, 445_000), 2_000_000);
  assert.equal(resolveContextTotal(undefined, 12_000), 0);
});

test("contextWindowForModel prefers catalog then inference", () => {
  assert.equal(contextWindowForModel({ id: "grok-4", contextWindow: 256_000 }), 256_000);
  assert.equal(contextWindowForModel({ id: "grok-4" }), 2_000_000);
  assert.equal(contextWindowForModel({ id: "grok-4", contextWindow: 128_000 }), 128_000);
  assert.equal(contextWindowForModel({ id: "zai:x:glm-4.6", contextWindow: 202_752 }), 202_752);
  assert.equal(contextWindowForModel({ id: "gpt-5", contextWindow: 1_047_576 }), 1_047_576);
});

test("formatContextWindow preserves non-market context sizes", () => {
  assert.equal(formatContextWindow(202_752), "203K");
  assert.equal(formatContextWindow(1_048_576), "1M");
  assert.equal(formatContextWindow(400_000), "400K");
  assert.equal(formatContextWindow(131_072), "131K");
});


test("contextPressure shares the runner compaction and critical UI thresholds", () => {
  assert.equal(contextPressure(159_999, 200_000).compactRecommended, false);
  assert.equal(contextPressure(160_000, 200_000).compactRecommended, true);
  assert.equal(contextPressure(179_999, 200_000).critical, false);
  assert.equal(contextPressure(180_000, 200_000).critical, true);
  assert.equal(contextPressure(220_000, 200_000).overflow, true);
  assert.equal(contextPressure(10_000, 0).known, false);
});

test("estimateContextTokens uses the shared serialized payload estimate", () => {
  assert.equal(estimateContextTokens("12345"), 2);
  assert.equal(
    estimateContextTokens({ role: "user", content: "hello", tools: [] }),
    Math.ceil(JSON.stringify({ role: "user", content: "hello", tools: [] }).length / 4),
  );
  assert.ok(
    estimateContextTokens({
      role: "assistant",
      content: "hello",
      tools: [{ input: "path", result: "result" }],
    }) > estimateContextTokens({ role: "assistant", content: "hello", tools: [] }),
  );
});


test("contextWindowForSelection follows the selected provider context parameter", () => {
  const cursorModel = {
    id: "gpt-5.6-sol",
    providerId: "cursor",
    defaultParams: [{ id: "context", value: "1m" }],
  };
  assert.equal(contextWindowForSelection(cursorModel, []), 1_000_000);
  assert.equal(contextWindowForSelection(cursorModel, [{ id: "context", value: "272k" }]), 272_000);
  assert.equal(contextWindowForSelection(cursorModel, [{ id: "context", value: "1.047576M" }]), 1_047_576);
 assert.equal(contextWindowForSelection(cursorModel, [{ id: "context", value: "unlimited" }]), 1_050_000);
 assert.equal(contextWindowForSelection({ id: "unknown-model" }, [{ id: "context", value: "max" }]), undefined);
 assert.equal(contextWindowForSelection({ id: "grok-4.6", providerId: "cursor" }), 2_000_000);
});

test("current GPT-5 family fallbacks keep long-context and mini variants distinct", () => {
  assert.equal(contextWindowForSelection({ id: "gpt-5.6-terra", providerId: "codex" }), 1_050_000);
  assert.equal(contextWindowForSelection({ id: "gpt-5.5", providerId: "codex" }), 1_050_000);
  assert.equal(contextWindowForSelection({ id: "gpt-5.4-mini", providerId: "codex" }), 400_000);
  assert.equal(formatContextWindow(1_050_000), "1.05M");
});

test("lastMeasuredInputTokens prefers contextUsedTokens over estimates", () => {
  assert.equal(lastMeasuredInputTokens({
    messages: [
      { runMetadata: { inputTokens: 10 } },
      { runMetadata: { inputTokens: 20, contextUsedTokens: 90_000 } },
    ],
  }), 90_000);
  assert.equal(lastMeasuredInputTokens({
    contextUsedTokens: 12_000,
    messages: [{ runMetadata: { inputTokens: 3 } }],
  }), 12_000);
});
