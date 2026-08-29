import assert from "node:assert/strict";
import test from "node:test";
import { runtimeEventFromRunEvent } from "../lib/runtime/from-run-event";

test("provider context telemetry becomes canonical context.pressure runtime data", () => {
  const event = runtimeEventFromRunEvent({
    id: 7,
    jobId: "job-1",
    chatId: "chat-1",
    event: "context",
    data: {
      usedTokens: 123_456,
      maxTokens: 1_000_000,
      inputTokens: 120_000,
      cachedInputTokens: 10_000,
      totalProcessedTokens: 200_000,
      compactsAutomatically: true,
      autoCompactThreshold: 800_000,
      source: "provider",
    },
    createdAt: "2026-08-26T20:00:00.000Z",
  });
  assert.equal(event?.type, "context.pressure");
  if (event?.type !== "context.pressure") throw new Error("expected context.pressure");
  assert.equal(event.payload.usedTokens, 123_456);
  assert.equal(event.payload.effectiveTotalTokens, 1_000_000);
  assert.equal(event.payload.cachedInputTokens, 10_000);
  assert.equal(event.payload.totalProcessedTokens, 200_000);
  assert.equal(event.payload.compactsAutomatically, true);
  assert.equal(event.payload.autoCompactThreshold, 800_000);
});
