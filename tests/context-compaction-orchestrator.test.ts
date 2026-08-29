import assert from "node:assert/strict";
import test from "node:test";
import type { ModelMessage } from "ai";
import {
  contextModeOf,
 CONTEXT_COMPACT_RATIO,
  effectiveContextBudget,
  estimateContextTokens,
  contextWindowForSelection,
} from "../lib/context-window";
import { compactChatHistoryForPrompt, compactProviderMessages, codexReasoningEffortForSelection } from "../lib/providers/runner";
import { readFileSync } from "node:fs";
import type { Chat } from "../lib/store";

const toolHistory: ModelMessage[] = [
  { role: "user", content: "Keep the current task and file state." },
  {
    role: "assistant",
    content: [{
      type: "tool-call",
      toolCallId: "read-1",
      toolName: "read_file",
      input: { path: "/workspace/src/important.ts", offset: 1, limit: 200 },
    }],
  },
  {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: "read-1",
      toolName: "read_file",
      output: {
        type: "text",
        value: `${"large file content ".repeat(4_000)}\nERROR: preserve this failure\nTODO: keep this todo`,
      },
    }],
  },
  { role: "assistant", content: "The file needs a focused fix." },
  { role: "user", content: "Continue without repeating completed work." },
  { role: "assistant", content: "Latest tail must remain available." },
];

test("compaction counts large tool payloads and stays within the effective budget", () => {
  const budget = effectiveContextBudget(4_000);
  const compacted = compactProviderMessages(toolHistory, 4_000);
  const estimated = compacted.reduce((sum, message) => sum + estimateContextTokens(message), 0);

  assert.ok(estimated <= budget, `estimated ${estimated} exceeds budget ${budget}`);
  assert.ok(JSON.stringify(compacted).includes("[metis-context-recap:v1]"));
  assert.ok(JSON.stringify(compacted).includes("Latest tail must remain available."));
});

test("compaction is deterministic and idempotent", () => {
  const once = compactProviderMessages(toolHistory, 4_000);
  const twice = compactProviderMessages(once, 4_000);
  assert.deepEqual(twice, once);
});

test("limited mode reduces the effective budget explicitly", () => {
  assert.equal(contextModeOf([{ id: "contextMode", value: "limited" }]), "limited");
  assert.ok(effectiveContextBudget(200_000, "limited") < effectiveContextBudget(200_000, "normal"));
});

test("compaction triggers at exactly 80% of the actual context window", () => {
  const contextWindow = 10_000;
  const threshold = Math.floor(contextWindow * CONTEXT_COMPACT_RATIO);
  const tokensOf = (messages: Array<{ role: "user" | "assistant"; content: string }>) =>
    messages.reduce((sum, message) => sum + estimateContextTokens(message), 0);
  const make = (chars: number) => [
    { role: "user" as const, content: "x".repeat(Math.max(1, chars)) },
    { role: "assistant" as const, content: "tail" },
  ];
  let chars = threshold * 4;
  while (chars > 4 && tokensOf(make(chars)) >= threshold) chars -= 32;
  const below = make(chars);
  let atChars = chars + 32;
  while (tokensOf(make(atChars)) < threshold) atChars += 32;
  const at = make(atChars);
  const belowEvents: Array<Record<string, unknown>> = [];
  const atEvents: Array<Record<string, unknown>> = [];
  compactProviderMessages(below, contextWindow, "normal", (event) => belowEvents.push(event));
  compactProviderMessages(at, contextWindow, "normal", (event) => atEvents.push(event));
  assert.equal(threshold, 8_000);
  assert.ok(tokensOf(below) < threshold);
  assert.ok(tokensOf(at) >= threshold);
  assert.equal(belowEvents.length, 0);
  assert.equal(atEvents[0]?.status, "started");
  assert.equal(atEvents[0]?.systemTriggered, true);
  assert.equal(atEvents[0]?.kind, "compaction");
  assert.equal(atEvents[0]?.id, atEvents.at(-1)?.id);
});

test("compaction emits a structured start and completion event", () => {
  const events: Array<Record<string, unknown>> = [];
  compactProviderMessages(toolHistory, 4_000, "normal", (event) => events.push(event));
  assert.equal(events[0]?.type, "compaction");
  assert.equal(events[0]?.status, "started");
  assert.equal(events.at(-1)?.status, "completed");
  assert.equal(typeof events.at(-1)?.afterTokens, "number");
});

test("Codex reasoning effort accepts only supported values", () => {
  assert.equal(
    codexReasoningEffortForSelection("gpt-5.6", [{ id: "effort", value: "xhigh" }]),
    "xhigh",
  );
  assert.equal(
    codexReasoningEffortForSelection("claude-opus-4-6", [{ id: "effort", value: "high" }]),
    undefined,
  );
  assert.equal(
    codexReasoningEffortForSelection("gpt-5.6", [{ id: "effort", value: "unsupported" }]),
    undefined,
  );
});

test("272K is selected only by an explicit matching context selection", () => {
  const model = { id: "gpt-5.6-sol", providerId: "cursor" };
  assert.notEqual(contextWindowForSelection(model), 272_000);
  assert.equal(
    contextWindowForSelection(model, [{ id: "context", value: "272k" }]),
    272_000,
  );
});

const workerSource = readFileSync(new URL("../lib/worker-runner.ts", import.meta.url), "utf8");

test("Cursor SDK prompt compaction uses the same 80% recap and skips the live turn", () => {
  const chat = {
    messages: [
      { id: "u1", role: "user", content: "Keep the current task and file state.", createdAt: "t" },
      {
        id: "a1",
        role: "assistant",
        content: "The file needs a focused fix.",
        createdAt: "t",
        tools: [{
          id: "read-1",
          name: "read_file",
          status: "completed",
          input: JSON.stringify({ path: "/workspace/src/important.ts" }),
          result: `${"large file content ".repeat(4_000)}\nERROR: preserve this failure\nTODO: keep this todo`,
        }],
      },
      { id: "u2", role: "user", content: "Continue without repeating completed work.", createdAt: "t" },
      { id: "live", role: "user", content: "LIVE_TURN_MUST_NOT_APPEAR", createdAt: "t" },
    ],
  } as Chat;
  const events: Array<Record<string, unknown>> = [];
  const result = compactChatHistoryForPrompt(chat, {
    excludeMessageId: "live",
    contextWindow: 4_000,
    onCompaction: (event) => events.push(event),
  });
  assert.equal(result.compacted, true);
  assert.match(result.text, /\[metis-context-recap:v1\]/);
  assert.doesNotMatch(result.text, /LIVE_TURN_MUST_NOT_APPEAR/);
  assert.equal(events[0]?.status, "started");
  assert.equal(events.at(-1)?.status, "completed");
});

test("Cursor SDK prompt compaction is a no-op below 80% of the window", () => {
  const chat = {
    messages: [
      { id: "u1", role: "user", content: "Short question.", createdAt: "t" },
      { id: "a1", role: "assistant", content: "Short answer.", createdAt: "t" },
    ],
  } as Chat;
  const events: Array<Record<string, unknown>> = [];
  const result = compactChatHistoryForPrompt(chat, {
    contextWindow: 200_000,
    onCompaction: (event) => events.push(event),
  });
  assert.equal(result.compacted, false);
  assert.equal(events.length, 0);
  assert.match(result.text, /Short question/);
});

test("Cursor worker compacts before resume and emits a compaction chip", () => {
  assert.match(workerSource, /compactChatHistoryForPrompt\(chat,/);
  assert.match(workerSource, /agent = \(job\.agentId \|\| chat\.agentId\) && !historyCompacted && !measuredPressure/);
  assert.match(workerSource, /emit\("compaction", event\)/);
  assert.match(workerSource, /compactedHistory\.text/);
});

test("measured provider usage forces compaction even when the transcript estimate is below 80%", () => {
  const small: ModelMessage[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "continue" },
  ];
  const events: Array<Record<string, unknown>> = [];
  compactProviderMessages(small, 100_000, "normal", (event) => events.push(event), 9_500_000);
  assert.equal(events.at(-1)?.status, "completed");
});

test("Cursor send includes native vision images and persists queued follow-ups server-side", () => {
  const uploads = readFileSync(new URL("../lib/uploads.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../worker.ts", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
  assert.match(uploads, /export function visionImagesForAttachments/);
  assert.match(workerSource, /visionImages\.length \? \{ text: prompt, images: visionImages \}/);
  assert.match(worker, /queuedAttachments\.length \? "\(see attachments\)"/);
  assert.match(worker, /drainPersistedChatQueues\(\);/);
  assert.match(shell, /function persistQueuedFollowUps/);
  assert.match(shell, /keepalive: true/);
  assert.match(shell, /pagehide/);
  assert.doesNotMatch(shell, /shouldAutoDrainQueue\(\{/);
});

