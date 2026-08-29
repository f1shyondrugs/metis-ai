import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("cursor worker forwards live tool and thinking updates from onDelta", () => {
  const source = readFileSync(path.join(root, "lib", "worker-runner.ts"), "utf8");
  assert.match(source, /handleDelta/);
  assert.match(source, /tool-call-started/);
  assert.match(source, /thinking-delta/);
  assert.match(source, /markSendProgress/);
  assert.match(source, /resolveMcpToolName/);
  assert.doesNotMatch(
    source,
    /if \(cancellationRequested \|\| update\.type !== "text-delta"\) return;/,
  );
});

test("cursor tool updates accept flat and nested SDK payload shapes", () => {
  const source = readFileSync(path.join(root, "lib", "worker-runner.ts"), "utf8");
  assert.match(source, /normalizedToolDelta/);
  assert.match(source, /toolCallId/);
  assert.match(source, /tool_input/);
  assert.match(source, /tool_result/);
  assert.match(source, /toolCall \\|\\| update\\.tool_call/);
});

test("xAI provider path exposes live web search tools", () => {
  const source = readFileSync(path.join(root, "lib", "providers", "adapters", "provider-support.ts"), "utf8");
  assert.match(source, /tools\.webSearch|tools\.web_search/);
  assert.match(source, /\.responses\(modelId\)/);
  assert.match(source, /onThinking/);
  assert.match(source, /part\.type === "reasoning-delta"/);
});

test("runtime timeline transport is durable SSE, not a client-side process-local bus", () => {
  const hook = readFileSync(path.join(root, "hooks", "use-timeline.ts"), "utf8");
  const route = readFileSync(path.join(root, "app", "api", "runtime", "events", "route.ts"), "utf8");
  assert.doesNotMatch(hook, /runtimeEventBus/);
  assert.match(hook, /new EventSource\(/);
  assert.match(route, /listRunEvents\(/);
  assert.match(route, /runtimeEventFromRunEvent/);
  assert.doesNotMatch(route, /runtimeEventBus/);
});


test("workspace creation schemas require real content and worker loads deploy overrides", () => {
  const gateway = readFileSync(path.join(root, "lib", "mcp-core", "gateway-core.mjs"), "utf8");
  const workerUnit = readFileSync(path.join(root, "deploy", "systemd", "metis-ai-worker.service.template"), "utf8");
  const plan = gateway.slice(gateway.indexOf('name: "create_plan"'), gateway.indexOf('name: "create_canvas"'));
  const canvasStart = gateway.indexOf('name: "create_canvas"');
  const canvas = gateway.slice(canvasStart, gateway.indexOf('name: "edit_plan"', canvasStart));
  assert.match(plan, /content: \{ type: "string", minLength: 1 \}/);
  assert.match(plan, /required: \["content"\]/);
  assert.match(canvas, /content: \{ type: "string", minLength: 1 \}/);
  assert.match(canvas, /required: \["content"\]/);
  assert.match(workerUnit, /EnvironmentFile=-YOUR_INSTALL_DIR\/.deploy\.env/);
});

test("terminal events and chat state commit before the worker lease is released", () => {
  const provider = readFileSync(path.join(root, "lib", "providers", "runner.ts"), "utf8");
  const providerStart = provider.indexOf("const completedChat = updateChat(");
  const providerEnd = provider.indexOf("completionCommitted = true", providerStart);
  assert.ok(providerStart >= 0 && providerEnd > providerStart);
  const providerTerminal = provider.slice(providerStart, providerEnd);
  assert.ok(providerTerminal.indexOf('emit("done"') > providerTerminal.indexOf("updateChat("));
  assert.ok(providerTerminal.indexOf('status: "completed"') > providerTerminal.indexOf('emit("done"'));

  const cursor = readFileSync(path.join(root, "lib", "worker-runner.ts"), "utf8");
  const cursorStart = cursor.indexOf("updateProviderSessionBinding({", cursor.indexOf("const completedAt"));
  const cursorEnd = cursor.indexOf("if (!job.incognito", cursorStart);
  assert.ok(cursorStart >= 0 && cursorEnd > cursorStart);
  const cursorTerminal = cursor.slice(cursorStart, cursorEnd);
  assert.ok(cursorTerminal.indexOf("updateChat(job.chatId") >= 0);
  const cursorEmit = Math.min(
    ...['emit("done"', 'emit("error"'].map((needle) => {
      const index = cursorTerminal.indexOf(needle);
      return index < 0 ? Number.POSITIVE_INFINITY : index;
    }),
  );
  assert.ok(Number.isFinite(cursorEmit));
  assert.ok(cursorEmit > cursorTerminal.indexOf("updateChat(job.chatId"));
  assert.ok(cursorTerminal.indexOf("updateJob(job.id") > cursorEmit);
});

test("canonical timeline keeps durable tool kinds for correct visualization", () => {
  const converter = readFileSync(path.join(root, "lib", "runtime", "from-run-event.ts"), "utf8");
  const reducer = readFileSync(path.join(root, "lib", "timeline", "reducer.ts"), "utf8");
  const card = readFileSync(path.join(root, "components", "timeline", "ToolRunCard.tsx"), "utf8");
  assert.match(converter, /kind: text\(data\.kind\)/);
  assert.match(reducer, /toolKind\?: string/);
  assert.match(reducer, /tool\.toolKind = toolEvent\.payload\.kind/);
  assert.doesNotMatch(card, /TOOL_ICONS\["edit"\]/);
  assert.doesNotMatch(card, /includes\("edit"\)/);
});
