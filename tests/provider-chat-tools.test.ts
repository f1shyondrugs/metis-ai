import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { modelSupportsChatTools } from "../lib/providers/discovery";

test("chat models keep tool support; embeddings/tts/whisper do not", () => {
  assert.equal(modelSupportsChatTools("gpt-5.4"), true);
  assert.equal(modelSupportsChatTools("claude-sonnet-4-6"), true);
  assert.equal(modelSupportsChatTools("gpt-4o-mini"), true);
  assert.equal(modelSupportsChatTools("text-embedding-3-large"), false);
  assert.equal(modelSupportsChatTools("whisper-1"), false);
  assert.equal(modelSupportsChatTools("tts-1-hd"), false);
  assert.equal(modelSupportsChatTools("sora-2"), false);
  assert.equal(modelSupportsChatTools("gpt-3.5-turbo-instruct"), false);
});

test("runner dispatches native providers through dedicated MCP-aware adapters", () => {
  const runner = readFileSync(new URL("../lib/providers/runner.ts", import.meta.url), "utf8");
  const index = readFileSync(new URL("../lib/providers/adapters/index.ts", import.meta.url), "utf8");
  const codex = readFileSync(new URL("../lib/providers/adapters/codex.ts", import.meta.url), "utf8");
  const claude = readFileSync(new URL("../lib/providers/adapters/claude.ts", import.meta.url), "utf8");
  const antigravity = readFileSync(new URL("../lib/providers/adapters/antigravity.ts", import.meta.url), "utf8");

  assert.match(runner, /providerAdapterForExecution\(providerExecution\(providerKey\)\)\.runTurn/);
  assert.match(index, /"codex-sdk": codexAdapter/);
  assert.match(index, /"claude-agent": claudeAdapter/);
  assert.match(index, /"antigravity-cli": antigravityAdapter/);
  assert.match(codex, /runTurn: runCodex/);
  assert.match(claude, /runTurn: runClaude/);
  assert.match(antigravity, /runOfficialAntigravityJob|runAntigravitySdkJob/);
  assert.match(antigravity, /authType === "oauth"/);
  assert.doesNotMatch(runner, /runOAuthAiSdk\(context, "codex"\)/);
  assert.match(claude, /claudeMcpServers\(/);
  assert.match(claude, /strictMcpConfig: true/);
});

test("grok and opencode stay on the ACP stdio path via registered adapters", () => {
  const runner = readFileSync(new URL("../lib/providers/runner.ts", import.meta.url), "utf8");
  const index = readFileSync(new URL("../lib/providers/adapters/index.ts", import.meta.url), "utf8");
  const acp = readFileSync(new URL("../lib/providers/adapters/acp-cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(runner, /runAcpStdioAgent/);
  assert.match(index, /"grok-cli": grokAdapter/);
  assert.match(index, /"opencode-cli": opencodeAdapter/);
  assert.match(acp, /runAcpStdioAgent/);
});
