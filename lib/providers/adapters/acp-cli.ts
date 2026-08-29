import type { ProviderContext } from "./provider-support";
import type { ProviderResult } from "./contract";
import { unsupported, type ProviderAdapterShape } from "./contract";
import { runAcpStdioAgent } from "@/lib/providers/acp-stdio";
import { getUserAgentCwd, getMcpServers } from "@/lib/mcp";
import {
  effectiveModelParams,
  providerConversationPrompt,
  providerMcpContext,
  providerPrompt,
} from "@/lib/providers/adapters/provider-support";

type AcpCliAdapterConfig = {
  readonly key: "grok-cli" | "opencode-cli";
  readonly binary: string;
  readonly args: readonly string[];
};

function acpCliAdapter(config: AcpCliAdapterConfig): ProviderAdapterShape {
  const capabilities = {
    contextOwner: "metis",
    persistentThreads: false,
    interruptibleTurns: true,
    interactiveRequests: false,
    sessionModelSwitch: "unsupported",
    nativeSubagents: false,
    nativeContextTelemetry: false,
  } as const;
  return {
    key: config.key,
    capabilities,
    runTurn: async (context: ProviderContext): Promise<ProviderResult> => {
      const binary =
        typeof context.connection.config.binaryPath === "string" &&
        context.connection.config.binaryPath.trim()
          ? context.connection.config.binaryPath.trim()
          : config.binary;
      const result = await runAcpStdioAgent({
        command: binary,
        args: [...config.args],
        cwd: getUserAgentCwd(context.job.userId),
        prompt: [
          providerPrompt(
            context.job,
            ["mcp"],
            true,
            effectiveModelParams(context.chat, context.job),
          ),
          providerConversationPrompt(context),
        ]
          .filter(Boolean)
          .join("\n\nUser request:\n"),
        mcp: getMcpServers(providerMcpContext(context)),
        signal: context.signal,
        clientName: "metis-ai",
        onText: context.onText,
        onTool: context.onTool,
      });
      return result.sessionId
        ? { agentId: `${config.binary}:${result.sessionId}` }
        : {};
    },
    startSession: () => unsupported("startSession", config.key),
    sendTurn: () => unsupported("sendTurn", config.key),
    interrupt: () => unsupported("interrupt", config.key),
    respondToRequest: () => unsupported("respondToRequest", config.key),
    respondToUserInput: () => unsupported("respondToUserInput", config.key),
    stopSession: () => unsupported("stopSession", config.key),
    readThread: () => unsupported("readThread", config.key),
    rollbackThread: () => unsupported("rollbackThread", config.key),
    streamEvents: () => unsupported("streamEvents", config.key),
  };
}

export const grokAdapter = acpCliAdapter({
  key: "grok-cli",
  binary: "grok",
  args: ["agent", "stdio"],
});

export const opencodeAdapter = acpCliAdapter({
  key: "opencode-cli",
  binary: "opencode",
  args: ["acp"],
});
