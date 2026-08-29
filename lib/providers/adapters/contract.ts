import type { ToolPart } from "@/lib/store";
import type { MetisRuntimeEvent } from "@/lib/runtime/events";
import type { ProviderContext } from "./provider-support";

export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  totalTokens?: number;
  totalProcessedTokens?: number;
  usedTokens?: number;
  maxTokens?: number;
  maxOutputTokens?: number;
  compactsAutomatically?: boolean;
  autoCompactThreshold?: number;
  costUsd?: number;
};

export type ProviderResult = {
  agentId?: string;
  usage?: ProviderUsage;
};

export type ProviderSession = {
  readonly id: string;
  readonly provider: ProviderExecutionKey;
  readonly threadId: string;
  readonly agentId?: string;
  readonly createdAt: string;
};

export type ProviderThreadTurnSnapshot = {
  readonly id: string;
  readonly items: ReadonlyArray<unknown>;
};

export type ProviderThreadSnapshot = {
  readonly threadId: string;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
};

export type ProviderStartSessionInput = {
  context: ProviderContext;
  resumeAgentId?: string;
};

export type ProviderSendTurnInput = {
  context: ProviderContext;
  prompt: string;
  sessionId?: string;
};

export type ProviderApprovalDecision = "allow" | "allow-session" | "deny";

export type ProviderUserInputAnswers = Record<string, unknown>;

export type ProviderExecutionKey =
  | "ai-sdk"
  | "codex-sdk"
  | "claude-agent"
  | "antigravity-cli"
  | "grok-cli"
  | "opencode-cli";

export type ProviderAdapterCapabilities = {
  readonly contextOwner: "native" | "metis";
  readonly persistentThreads: boolean;
  readonly interruptibleTurns: boolean;
  readonly interactiveRequests: boolean;
  readonly sessionModelSwitch: "in-session" | "restart-resume" | "unsupported";
  readonly nativeSubagents: boolean;
  readonly nativeContextTelemetry: boolean;
};

export type ProviderAdapter = {
  readonly runTurn: (context: ProviderContext) => Promise<ProviderResult>;
};

export type ProviderAdapterShape = ProviderAdapter & {
  readonly key: ProviderExecutionKey;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly startSession: (input: ProviderStartSessionInput) => Promise<ProviderSession>;
  readonly sendTurn: (input: ProviderSendTurnInput) => Promise<ProviderResult>;
  readonly interrupt: (context: ProviderContext, turnId?: string) => Promise<void>;
  readonly respondToRequest: (
    context: ProviderContext,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  readonly respondToUserInput: (
    context: ProviderContext,
    requestId: string,
    answers: ProviderUserInputAnswers,
  ) => Promise<void>;
  readonly stopSession: (context: ProviderContext) => Promise<void>;
  readonly readThread: (context: ProviderContext) => Promise<ProviderThreadSnapshot>;
  readonly rollbackThread: (context: ProviderContext, turns: number) => Promise<ProviderThreadSnapshot>;
  readonly streamEvents: (context: ProviderContext) => AsyncIterable<MetisRuntimeEvent>;
};

export function unsupported(operation: string, provider: ProviderExecutionKey): never {
  throw new Error(`${provider} does not support ${operation}.`);
}
