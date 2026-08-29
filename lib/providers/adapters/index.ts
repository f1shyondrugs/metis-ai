import type { ProviderExecution } from "@/lib/providers/run-kind";
import type { ProviderAdapterShape } from "./contract";
import { aiSdkAdapter } from "./ai-sdk";
import { codexAdapter } from "./codex";
import { claudeAdapter } from "./claude";
import { antigravityAdapter } from "./antigravity";
import { grokAdapter, opencodeAdapter } from "./acp-cli";

const adapters: Record<ProviderExecution, ProviderAdapterShape | undefined> = {
  "ai-sdk": aiSdkAdapter,
  "codex-sdk": codexAdapter,
  "claude-agent": claudeAdapter,
  "antigravity-cli": antigravityAdapter,
  "grok-cli": grokAdapter,
  "opencode-cli": opencodeAdapter,
  // Cursor remains handled by the existing worker path until its adapter port.
  "cursor-agent": undefined,
};

export function providerAdapterForExecution(
  execution: ProviderExecution,
): ProviderAdapterShape {
  const adapter = adapters[execution];
  if (!adapter) {
    throw new Error(`No provider adapter is available for ${execution}.`);
  }
  return adapter;
}
