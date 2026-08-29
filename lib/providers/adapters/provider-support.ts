import {
  jsonSchema,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createGoogleVertex } from "@ai-sdk/google-vertex";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  appendMessage,
  getChat,
  getGlobalModelSettings,
  updateChat,
  upsertMessage,
  type Chat,
  type ToolPart,
} from "@/lib/db-store";
import { getProject, projectContextBlock } from "@/lib/projects";
import type { MessagePart } from "@/lib/store";
import { skillsCatalogPrompt } from "@/lib/skills";
import { getJob, appendRunEvent, updateJob } from "@/lib/db-jobs";
import { buildAttachmentPrompt } from "@/lib/uploads";
import { providerModelsForConnection } from "@/lib/providers/discovery";
import {
  findActiveConnection,
  getProviderConnection,
  getProviderConnectionSecret,
  type ProviderConnectionWithSecret,
} from "@/lib/provider-connections";
import { getProviderDefinition } from "@/lib/providers/registry";
import type { ProviderResult } from "./contract";
import type { AgentJob } from "@/lib/jobs";
import { modeById } from "@/lib/modes";
import {
  contextModeOf,
  CONTEXT_COMPACT_RATIO,
  effectiveContextBudget,
  estimateContextTokens,
  type ContextMode,
  contextWindowForSelection,
} from "@/lib/context-window";
import { persistToolsForMessage } from "@/lib/tool-persistence";
import { metisAgentIdentity } from "@/lib/agent-identity";
import { compress } from "@/lib/compression";
import { stripRawToolMarkup } from "@/lib/providers/tool-schema";
import {
  executeEmbeddedToolFallbacks,
  type EmbeddedToolExecution,
} from "@/lib/providers/embedded-tool-fallback";
import {
  classifyToolKind,
  innerToolName,
  todosFromToolPayload,
} from "@/lib/tool-call-display";
import { subagentMetadataFromTool } from "@/lib/subagent-tool";
import { LoopGuard, routeTask } from "@/lib/agent-efficiency";
import { buildMcpContext, getMcpBridgeEnv, getMcpServers } from "@/lib/mcp";
import { runtimeModeForChat } from "@/lib/runtime-mode";
import { mcpBridgeTools } from "@/lib/mcp-bridge";
import {
  METIS_SHARED_AGENT_CONTROL,
  toolContractPrompt,
} from "@/lib/agent-control";
import { buildProviderPrompt } from "@/lib/providers/prompt-context";
import type { TaskCategory } from "@/lib/model-telemetry";

export type Usage = {
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

export type ProviderContext = {
  job: AgentJob;
  chat: Chat;
  connection: ProviderConnectionWithSecret;
  modelId: string;
  signal: AbortSignal;
  onText: (value: string) => void;
  onTool: (tool: ToolPart) => void;
  onThinking: (data: {
    text?: string;
    replace?: boolean;
    done?: boolean;
    durationMs?: number;
  }) => void;
  onStream: (data: Record<string, unknown>) => void;
  onCompaction: (event: CompactionEvent) => void;
};

export function telemetryCategory(message: string): TaskCategory {
  const text = String(message || "");
  if (/\b(debug|bug|error|crash|fehler|kaputt)\b/i.test(text))
    return "debugging";
  if (
    /\b(implement|build|edit|fix|refactor|code|änder|baue|umsetzen)\b/i.test(
      text,
    )
  )
    return "coding";
  if (/\b(research|analyse|analyze|recherch|dokumentation|prüf)\b/i.test(text))
    return "research";
  if (text.length > 2_500) return "long-context";
  return "chat";
}

export function finalizeAlternativeTools(tools: ToolPart[]) {
  for (const tool of tools) {
    if (tool.status !== "running") continue;
    tool.status = "error";
    tool.result ||= "Provider ended before returning a tool result.";
  }
}

export type CompactionEvent = {
  type: "compaction";
  id: string;
  name: "context_compaction";
  kind: "compaction";
  systemTriggered: true;
  status: "started" | "completed" | "error";
  beforeTokens?: number;
  targetTokens?: number;
  afterTokens?: number;
  removedMessages?: number;
  message?: string;
};

const remoteToolSchema = jsonSchema<Record<string, unknown>>({
  type: "object",
  properties: {
    target: {
      type: "string",
      description: "server or client:<remote-client-id>",
    },
    path: { type: "string" },
    content: { type: "string" },
    oldText: { type: "string" },
    newText: { type: "string" },
    command: { type: "string" },
    cwd: { type: "string" },
    timeout: { type: "integer" },
    client_id: { type: "string" },
  },
  additionalProperties: true,
});

export function providerRemoteTools(context: ProviderContext): ToolSet {
  const mode = modeById(
    context.job.modeId || context.chat.sessionState?.modeId,
  );
  const canWrite = mode.allowedCategories.includes("write");
  const canRemote = mode.allowedCategories.includes("remote");
  if (!canRemote) return {};
  const call = async (action: string, args: Record<string, unknown> = {}) => {
    const clientId =
      typeof args.target === "string" && args.target.startsWith("client:")
        ? args.target.slice("client:".length).trim()
        : typeof args.client_id === "string"
          ? args.client_id
          : "";
    if (action === "list_remote_clients") {
      const response = await fetch(
        process.env.AI_CHAT_INTERNAL_REMOTE_CLIENT_URL ||
          `http://127.0.0.1:${process.env.PORT || "3100"}/api/internal/remote-client`,
        {
          headers: {
            Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "")}`,
            "X-AI-Chat-User-Id": String(context.job.userId || ""),
          },
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(body.error || "Failed to list remote clients");
      return body.clients || [];
    }
    if (!clientId) throw new Error("target must be client:<remote-client-id>");
    const response = await fetch(
      process.env.AI_CHAT_INTERNAL_REMOTE_CLIENT_URL ||
        `http://127.0.0.1:${process.env.PORT || "3100"}/api/internal/remote-client`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "")}`,
          "X-AI-Chat-User-Id": String(context.job.userId || ""),
        },
        body: JSON.stringify({
          clientId,
          action,
          params: args,
          source: "agent",
        }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Remote ${action} failed`);
    return body.result;
  };
  const remoteTool = (
    description: string,
    execute: (args: Record<string, unknown>) => Promise<unknown>,
  ) =>
    tool({
      description,
      inputSchema: remoteToolSchema,
      execute,
    } as never) as ToolSet[string];
  const tools: ToolSet = {
    list_remote_clients: remoteTool(
      "List all connected remote clients and their status.",
      () => call("list_remote_clients"),
    ),
    read_file: remoteTool("Read a UTF-8 file from a remote client.", (args) =>
      call("read_file", args),
    ),
    list_directory: remoteTool("List a directory on a remote client.", (args) =>
      call("list_directory", args),
    ),
    execute_command: remoteTool("Run a command on a remote client.", (args) =>
      call("execute_command", args),
    ),
  };
  if (canWrite) {
    tools.write_file = remoteTool(
      "Create or overwrite a UTF-8 file on a remote client.",
      (args) => call("write_file", args),
    );
    tools.edit_file = remoteTool(
      "Replace oldText with newText in a remote client file.",
      (args) => call("edit_file", args),
    );
    tools.delete_file = remoteTool(
      "Delete a file on a remote client.",
      (args) => call("delete_file", args),
    );
  }
  return tools;
}

export function providerLanguageTools(context: ProviderContext): ToolSet {
  const tools: ToolSet = { ...providerRemoteTools(context) };
  Object.assign(tools, providerNativeSearchTools(context));
  return tools;
}

export function providerNativeSearchTools(context: ProviderContext): ToolSet {
  if (context.connection.providerKey !== "xai") return {};
  const client = createXai({
    apiKey: context.connection.secret,
    ...(context.connection.baseUrl
      ? { baseURL: context.connection.baseUrl }
      : {}),
  });
  return {
    web_search: client.tools.webSearch() as never,
    x_search: client.tools.xSearch() as never,
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function inheritedEnv(extra: Record<string, string | undefined> = {}) {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...extra }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function providerTaskMessage(job: AgentJob) {
  return (
    job.resumePrompt?.trim() ||
    job.message ||
    "Continue the current task without repeating completed work."
  );
}

export function providerPrompt(
  job: AgentJob,
  toolNames?: ReadonlyArray<string>,
  nativeTools = false,
  _modelParams?: ReadonlyArray<{ id: string; value: string }> | null,
  provider = "alternative-provider",
) {
  return buildProviderPrompt({ job, toolNames, nativeTools, provider });
}

function parseToolInput(value?: string) {
  if (!value?.trim()) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}

function modelMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object") return String(part ?? "");
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join("\n");
}

export function stripProviderReasoning(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string")
      return message;
    return {
      ...message,
      content: message.content.filter((part) => part.type !== "reasoning"),
    };
  });
}

export function chatToModelMessages(
  chat: Chat,
  excludeMessageId?: string,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const message of chat.messages) {
    if (excludeMessageId && message.id === excludeMessageId) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = message.content.trim();
    const tools = message.tools || [];
    if (!content && !tools.length) continue;
    if (message.role === "user") {
      messages.push({ role: "user", content: content || "respond." });
      continue;
    }
    if (!tools.length) {
      messages.push({ role: "assistant", content: content });
      continue;
    }
    messages.push({
      role: "assistant",
      content: [
        ...(content ? [{ type: "text" as const, text: content }] : []),
        ...tools.map((item) => ({
          type: "tool-call" as const,
          toolCallId: item.id,
          toolName: item.name,
          input: parseToolInput(item.input),
        })),
      ],
    });
    messages.push({
      role: "tool",
      content: tools.map((item) => ({
        type: "tool-result" as const,
        toolCallId: item.id,
        toolName: item.name,
        output:
          item.status === "error"
            ? { type: "error-text" as const, value: item.result || item.status }
            : { type: "text" as const, value: item.result || item.status },
      })),
    });
  }
  return messages;
}

export function serializeModelMessagesForPrompt(messages: ModelMessage[]): string {
  const blocks: string[] = [];
  for (const message of messages) {
    const text = modelMessageText(message).trim();
    if (!text) continue;
    const speaker =
      message.role === "user"
        ? "User"
        : message.role === "assistant"
          ? "Assistant"
          : "Tool";
    blocks.push(`${speaker}:\n${text}`);
  }
  return blocks.join("\n\n");
}

/** Compact chat history for Cursor SDK (string prompt) using the same 80% policy as AI-SDK providers. */
export function compactChatHistoryForPrompt(
  chat: Chat,
  options: {
    excludeMessageId?: string;
    contextWindow?: number;
    contextMode?: ContextMode;
    onCompaction?: (event: CompactionEvent) => void;
    maxChars?: number;
  } = {},
): { text: string; compacted: boolean } {
  const messages = chatToModelMessages(chat, options.excludeMessageId);
  let compacted = false;
  const next = compactIfNeeded(
    messages,
    options.contextWindow,
    options.contextMode || "normal",
    (event) => {
      if (event.status === "completed") compacted = true;
      options.onCompaction?.(event);
    },
  );
  let text = serializeModelMessagesForPrompt(next);
  const maxChars = options.maxChars ?? 120_000;
  if (text.length > maxChars) {
    text = `[Earlier persisted messages truncated to fit the model context]\n${text.slice(-maxChars)}`;
  }
  return { text, compacted };
}

export function modelMessages(
  chat: Chat,
  job: AgentJob,
  contextWindow?: number,
  contextMode: ContextMode = "normal",
  onCompaction?: (event: CompactionEvent) => void,
): ModelMessage[] {
  const messages = chatToModelMessages(chat);
  if (!messages.some((message) => message.role === "user")) {
    messages.push({ role: "user", content: job.message || "respond." });
  }
  return compactIfNeeded(messages, contextWindow, contextMode, onCompaction);
}

export function effectiveModelParams(chat: Chat, job: AgentJob) {
  return job.modelParams?.length ? job.modelParams : chat.modelParams;
}

export function estimateProviderInputTokens(
  chat: Chat,
  job: AgentJob,
  modelId: string,
) {
  const contextWindow = contextWindowForSelection(
    { id: modelId, providerId: job.modelId ? job.modelId.split(":")[0] : "" },
    effectiveModelParams(chat, job),
  );
  const messages = modelMessages(
    chat,
    job,
    contextWindow,
    contextModeOf(effectiveModelParams(chat, job)),
  );
  // Includes the provider/system instructions plus the exact compacted chat
  // payload. Historical tool inputs/results are represented in modelMessages
  // as native tool-call/tool-result parts (text recap only after compaction).
  return Math.max(
    1,
    estimateContextTokens({
      instructions: providerPrompt(job),
      messages,
    }),
  );
}

/**
 * Auto-compaction: when the estimated token footprint of the history
 * approaches the model's context window, older messages are compressed
 * (tool-output style compaction keeps errors/summaries) so the run never
 * trips over the provider's input limit. The last few exchanges stay intact.
 */
/** Resolve the effective context window for the job's model (catalog value
 *  first, family inference fallback). Returns undefined when unknown —
 *  compaction is then skipped rather than guessing. */
export function resolvedContextWindow(context: ProviderContext): number | undefined {
  try {
    const discovered = providerModelsForConnection(context.connection)
      .find((model) => model.id === context.modelId);
    return contextWindowForSelection(
      discovered || { id: context.modelId, providerId: context.connection.providerKey },
      effectiveModelParams(context.chat, context.job),
    );
  } catch {
    return undefined;
  }
}

export function providerCurrentTurnPrompt(context: ProviderContext): string {
  const job = context.job;
  const references = (job.references || []).map((reference) => [
    `- [${reference.kind}] ${reference.label}`,
    reference.detail ? `  Detail: ${reference.detail}` : "",
    reference.path ? `  Path/URL: ${reference.path}` : "",
    reference.content ? `  Context:\n${reference.content}` : "",
  ].filter(Boolean).join("\n")).join("\n");
  return [
    providerTaskMessage(job),
    references ? `Current-turn references:\n${references}` : "",
    job.referenceText ? `Current-turn referenced context:\n${job.referenceText}` : "",
    buildAttachmentPrompt(job.chatId, job.attachments, job.userId),
  ].filter(Boolean).join("\n\n");
}

export function nativeRecoveryPrompt(context: ProviderContext, maxChars = 120_000): string {
  const compacted = compactChatHistoryForPrompt(context.chat, {
    excludeMessageId: context.job.messageId,
    contextWindow: resolvedContextWindow(context),
    contextMode: contextModeOf(effectiveModelParams(context.chat, context.job)),
    maxChars,
  });
  if (!compacted.text.trim()) return providerCurrentTurnPrompt(context);
  const bounded = compacted.text.length > maxChars ? compacted.text.slice(-maxChars) : compacted.text;
  return [
    providerCurrentTurnPrompt(context),
    `Recovery bootstrap ${COMPACTION_MARKER}: the native provider session was unavailable. This is a one-time bounded checkpoint from durable Metis history. Preserve task state, decisions, changed files, tests/errors, and TODOs; do not replay or summarize it back to the user.`,
    bounded,
  ].join("\n\n");
}

export function providerConversationPrompt(context: ProviderContext): string {
  const contextWindow = resolvedContextWindow(context);
  const messages = modelMessages(
    context.chat,
    context.job,
    contextWindow,
    contextModeOf(effectiveModelParams(context.chat, context.job)),
  );
  const history = messages
    .map((message) => `${message.role}: ${modelMessageText(message)}`)
    .join("\n");
  return [
    providerTaskMessage(context.job),
    "Compacted conversation context (follow the latest task and preserve state from files, todos, errors, and tool results):",
    history,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function compactMessageRecap(message: ModelMessage): string {
  const text = modelMessageText(message);
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return `${message.role}: ${text}`;
  }
  const tools: ToolPart[] = [];
  for (const part of message.content) {
    if (
      !part ||
      typeof part !== "object" ||
      !("type" in part) ||
      part.type !== "tool-call"
    )
      continue;
    tools.push({
      id: String("toolCallId" in part ? part.toolCallId : ""),
      name: String("toolName" in part ? part.toolName : "tool"),
      status: "completed",
      input:
        typeof ("input" in part ? part.input : undefined) === "string"
          ? String(part.input)
          : JSON.stringify("input" in part ? (part.input ?? {}) : {}),
    });
  }
  const recap = tools.length
    ? `\nTools already executed:\n${toolRecap(tools)}`
    : "";
  return `${message.role}: ${text}${recap}`;
}

export function toolRecap(tools: ToolPart[]) {
  return tools
    .map((item) => {
      const input = item.input ? ` input=${item.input.slice(0, 400)}` : "";
      const result =
        item.result && item.kind !== "read"
          ? ` result=${item.result.slice(0, 800)}`
          : "";
      return `- ${item.name} (${item.status})${item.path ? ` path=${item.path}` : ""}${input}${result}`;
    })
    .join("\n");
}

export const COMPACTION_MARKER = "[metis-context-recap:v1]";

export function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 32) return value.slice(0, maxChars);
  const tail = Math.floor(maxChars * 0.25);
  return `${value.slice(0, maxChars - tail - 32)} … [truncated] … ${value.slice(-tail)}`;
}

export function compactIfNeeded(
  messages: ModelMessage[],
  contextWindow?: number,
  contextMode: ContextMode = "normal",
  onCompaction?: (event: CompactionEvent) => void,
): ModelMessage[] {
  if (!contextWindow || contextWindow <= 0 || messages.length < 2)
    return messages;
  const total = messages.reduce(
    (sum, message) => sum + estimateContextTokens(message),
    0,
  );
  const budget = effectiveContextBudget(contextWindow, contextMode);
  if (total / contextWindow < CONTEXT_COMPACT_RATIO) return messages;
  // One compact per pressure wave. A recap is already canonical; compacting it
  // again would drop the tail and break idempotency on the next runner step.
  if (
    messages.some((message) =>
      modelMessageText(message).includes(COMPACTION_MARKER),
    )
  ) {
    return messages;
  }

  // A prior recap is already canonical. Re-summarizing it would make repeated
  // compaction non-idempotent and can slowly erase the original task.
  const head = messages.filter(
    (message) => !modelMessageText(message).includes(COMPACTION_MARKER),
  );
  const source =
    head.length === messages.length
      ? messages
      : messages.slice(-Math.max(2, Math.floor(messages.length * 0.45)));
  const protectedTail: ModelMessage[] = [];
  let tailTokens = 0;
  let index = source.length;
  const tailBudget = Math.floor(budget * 0.45);
  while (index > 0 && tailTokens < tailBudget) {
    index -= 1;
    const message = source[index];
    protectedTail.unshift(message);
    tailTokens += estimateContextTokens(message);
  }
  const oldMessages = source.slice(0, index);
  const compactionId = `context-compaction-${Date.now()}`;
  onCompaction?.({
    type: "compaction",
    id: compactionId,
    name: "context_compaction",
    kind: "compaction",
    systemTriggered: true,
    status: "started",
    beforeTokens: total,
    targetTokens: budget,
    removedMessages: oldMessages.length,
  });
  const recap = oldMessages
    .map((message) => compress(compactMessageRecap(message), "stacked"))
    .join("\n")
    .replace(/\s+$/g, "");
  const recapPrefix = `Compressed conversation history ${COMPACTION_MARKER} (older messages were auto-compacted; preserve task state, files, todos, errors, and the latest tail):\n`;
  const recapBudget = Math.max(64, (budget - tailTokens - 8) * 4);
  let result: ModelMessage[] = [
    {
      role: "user",
      content: `${recapPrefix}${boundedText(recap, recapBudget)}`,
    },
    ...protectedTail,
  ];
  // A single giant tool result can fill the protected tail by itself. Bound
  // every message until the measured payload is within the effective budget.
  let trimPasses = 0;
  const maxTrimPasses = Math.max(8, result.length * 4);
  while (
    result.reduce((sum, message) => sum + estimateContextTokens(message), 0) >
      budget &&
    result.length > 1
  ) {
    const excess =
      result.reduce((sum, message) => sum + estimateContextTokens(message), 0) -
      budget;
    let candidateIndex = -1;
    let candidateChars = 0;
    for (let index = 1; index < result.length; index += 1) {
      const chars = modelMessageText(result[index]).length;
      if (chars > candidateChars) {
        candidateIndex = index;
        candidateChars = chars;
      }
    }
    if (candidateIndex < 0 || candidateChars <= 32) break;
    const candidate = result[candidateIndex];
    const allowed = Math.max(32, candidateChars - Math.max(1, excess) * 4);
    if (allowed >= candidateChars) break;
    result[candidateIndex] = {
      role: candidate.role,
      content: boundedText(modelMessageText(candidate), allowed),
    } as ModelMessage;
    trimPasses += 1;
    if (trimPasses >= maxTrimPasses) break;
  }
  if (
    result.reduce((sum, message) => sum + estimateContextTokens(message), 0) >
    budget
  ) {
    const last = result.at(-1);
    result = [
      {
        role: "user",
        content: `${recapPrefix}${boundedText(recap, Math.max(32, (budget - estimateContextTokens(last || "") - 2) * 4))}`,
      },
      ...(last
        ? [
            {
              role: last.role,
              content: boundedText(
                modelMessageText(last),
                Math.max(32, (budget - 2) * 4),
              ),
            } as ModelMessage,
          ]
        : []),
    ];
  }
  onCompaction?.({
    type: "compaction",
    id: compactionId,
    name: "context_compaction",
    kind: "compaction",
    systemTriggered: true,
    status: "completed",
    beforeTokens: total,
    targetTokens: budget,
    afterTokens: result.reduce(
      (sum, message) => sum + estimateContextTokens(message),
      0,
    ),
    removedMessages: oldMessages.length,
  });
  return result;
}

export function compactProviderMessages(
  messages: ModelMessage[],
  contextWindow: number,
  contextMode: ContextMode = "normal",
  onCompaction?: (event: CompactionEvent) => void,
): ModelMessage[] {
  return compactIfNeeded(messages, contextWindow, contextMode, onCompaction);
}

export function codexReasoningEffortForSelection(
  modelId: string,
  params?: ReadonlyArray<{ id: string; value: string }> | null,
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (!/^(?:gpt[-_.]?5|codex)/i.test(modelId.trim())) return undefined;
  const value = params?.find(
    (param) => param.id === "effort" || param.id === "reasoning",
  )?.value;
  return value && ["minimal", "low", "medium", "high", "xhigh"].includes(value)
    ? (value as "minimal" | "low" | "medium" | "high" | "xhigh")
    : undefined;
}

export function aiReasoningForSelection(
  providerKey: string,
  params?: ReadonlyArray<{ id: string; value: string }> | null,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  const value = params?.find(
    (param) => param.id === "effort" || param.id === "reasoning",
  )?.value;
  if (!value) return providerKey === "codex" ? "none" : undefined;
  const allowed =
    providerKey === "anthropic" || providerKey === "google"
      ? ["none", "low", "medium", "high"]
      : ["none", "minimal", "low", "medium", "high", "xhigh"];
  return allowed.includes(value)
    ? (value as "none" | "minimal" | "low" | "medium" | "high" | "xhigh")
    : undefined;
}

export function aiModel(
  providerKey: string,
  modelId: string,
  connection: ProviderConnectionWithSecret,
): LanguageModel {
  const secret = connection.secret;
  const baseURL = connection.baseUrl;
  if (
    providerKey === "openai" ||
    (providerKey === "codex" && connection.authType === "api_key")
  ) {
    return createOpenAI({
      apiKey: secret,
      ...(baseURL ? { baseURL } : {}),
    }).chat(modelId);
  }
  if (providerKey === "anthropic") {
    return createAnthropic({
      apiKey: secret,
      ...(baseURL ? { baseURL } : {}),
    }).messages(modelId);
  }
  if (providerKey === "google") {
    if (connection.authType === "vertex_adc") {
      return createGoogleVertex({
        project:
          typeof connection.config.project === "string"
            ? connection.config.project
            : undefined,
        location:
          typeof connection.config.location === "string"
            ? connection.config.location
            : undefined,
      }).languageModel(modelId);
    }
    return createGoogle({
      apiKey: secret,
      ...(baseURL ? { baseURL } : {}),
    }).chat(modelId);
  }
  if (providerKey === "xai") {
    return createXai({
      apiKey: secret,
      ...(baseURL ? { baseURL } : {}),
    }).responses(modelId);
  }
  if (providerKey === "openrouter") {
    return createOpenRouter({
      apiKey: secret,
      ...(baseURL ? { baseUrl: baseURL } : {}),
    }).chat(modelId);
  }
  if (providerKey === "ollama" || providerKey === "compatible") {
    if (!baseURL)
      throw new Error("An OpenAI-compatible connection requires a base URL.");
    return createOpenAICompatible({
      name: `${providerKey}-${connection.id}`,
      baseURL,
      ...(secret ? { apiKey: secret } : {}),
    }).chatModel(modelId);
  }
  throw new Error(`Provider ${providerKey} is not a chat API provider.`);
}

function selectedReasoningEffort(
  params?: ReadonlyArray<{ id: string; value: string }> | null,
) {
  return params?.find((param) => param.id === "effort" || param.id === "reasoning")?.value;
}

function isGlm53CompatibleModel(modelId: string) {
  return /(?:^|[\/:_-])glm[-_.]?5(?:[.-]?3|p3)(?:$|[\/:_-])/i.test(modelId.trim());
}

export function compatibleProviderOptionsForSelection(
  connection: Pick<ProviderConnectionWithSecret, "id" | "providerKey">,
  modelId: string,
  params?: ReadonlyArray<{ id: string; value: string }> | null,
) {
  if (connection.providerKey !== "compatible") return undefined;
  const selected = selectedReasoningEffort(params);
  const glm53 = isGlm53CompatibleModel(modelId);
  let reasoningEffort = selected;
  if (glm53 && selected) {
    if (["none", "minimal", "low"].includes(selected)) reasoningEffort = "low";
    else if (["medium", "high"].includes(selected)) reasoningEffort = "high";
    else if (["xhigh", "max", "ultra"].includes(selected)) reasoningEffort = "max";
  }
  const options = {
    ...(reasoningEffort && reasoningEffort !== "none" ? { reasoningEffort } : {}),
    ...(glm53 ? { thinking: { type: "enabled" } } : {}),
  };
  if (!Object.keys(options).length) return undefined;
  return { [`compatible-${connection.id}`]: options };
}

export function anthropicProviderOptionsForSelection(
  modelId: string,
  params?: ReadonlyArray<{ id: string; value: string }> | null,
) {
  const selectedWindow = contextWindowForSelection(
    { id: modelId, providerId: "anthropic" },
    params,
  );
  if (selectedWindow !== 1_000_000) return undefined;
  if (!/claude-(?:sonnet|opus)-(?:4(?:-|$)|4\.5(?:[-.]|$))/i.test(modelId))
    return undefined;
  return {
    anthropic: {
      anthropicBeta: ["context-1m-2025-08-07"],
    },
  };
}

export function providerOptionsFor(context: ProviderContext) {
  const params = effectiveModelParams(context.chat, context.job);
  if (context.connection.providerKey === "anthropic") {
    return anthropicProviderOptionsForSelection(context.modelId, params);
  }
  if (context.connection.providerKey === "compatible") {
    return compatibleProviderOptionsForSelection(context.connection, context.modelId, params);
  }
  return undefined;
}

export function streamErrorText(value: unknown) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const DEFAULT_PROVIDER_STEPS = 50;

export async function consumeAiStream(
  result: ReturnType<typeof streamText>,
  context: ProviderContext,
  fallbackTools: ToolSet,
  initiatingMessages: ModelMessage[],
  resumeEmbedded?: (
    messages: ModelMessage[],
    remainingSteps: number,
  ) => ReturnType<typeof streamText>,
  initialSteps = DEFAULT_PROVIDER_STEPS,
) {
  let textProduced = false;
  let toolsProduced = false;
  let finishReason = "";
  let conversation = initiatingMessages;
  let current = result;
  let remainingSteps = Math.max(
    1,
    Math.min(DEFAULT_PROVIDER_STEPS * 2, Math.floor(initialSteps)),
  );
  const loopGuard = new LoopGuard();
  let fallbackIndex = 0;
  const usage: Usage = {};

  const addUsage = (part: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }) => {
    usage.inputTokens = (usage.inputTokens || 0) + (part.inputTokens || 0);
    usage.outputTokens = (usage.outputTokens || 0) + (part.outputTokens || 0);
    usage.totalTokens = (usage.totalTokens || 0) + (part.totalTokens || 0);
  };

  const consumeRound = async (streamResult: ReturnType<typeof streamText>) => {
    let providerError = "";
    let rawText = "";
    let pendingText = "";
    let visibleText = "";
    const rawToolMarkup: string[] = [];
    const roundSignatures: string[] = [];
    let nativeTools = false;

    const emitText = (value: string) => {
      if (!value) return;
      textProduced = true;
      visibleText += value;
      context.onText(value);
    };

    const drainText = (final = false) => {
      const XML_START = "<tool_call>";
      const XML_END = "</tool_call>";
      const ALT_START = "<|tool_call_begin|>";
      const ALT_END = "<|tool_call_end|>";
      const JSON_START = "```json";
      const markers = [XML_START, ALT_START, JSON_START];
      const hold = Math.max(...markers.map((marker) => marker.length)) - 1;

      while (pendingText) {
        const positions = markers
          .map((marker) => ({ marker, index: pendingText.indexOf(marker) }))
          .filter((entry) => entry.index >= 0)
          .sort((a, b) => a.index - b.index);
        const next = positions[0];
        if (!next) {
          if (final) {
            const cleaned = stripRawToolMarkup(pendingText)
              .replace(/<tool_call>[\s\S]*$/i, "")
              .replace(/<\|tool_call_begin\|>[\s\S]*$/i, "");
            emitText(cleaned);
            pendingText = "";
            return;
          }
          const flushLength = Math.max(0, pendingText.length - hold);
          if (!flushLength) return;
          const safe = pendingText.slice(0, flushLength);
          pendingText = pendingText.slice(flushLength);
          emitText(safe);
          continue;
        }

        if (next.index > 0) {
          const safe = pendingText.slice(0, next.index);
          pendingText = pendingText.slice(next.index);
          emitText(safe);
          continue;
        }

        if (next.marker === JSON_START) {
          const end = pendingText.indexOf("```", JSON_START.length);
          if (end < 0) {
            if (final) {
              emitText(stripRawToolMarkup(pendingText));
              pendingText = "";
            }
            return;
          }
          const block = pendingText.slice(0, end + 3);
          pendingText = pendingText.slice(end + 3);
          if (/"name"\s*:\s*"[^"]+"/.test(block)) rawToolMarkup.push(block);
          else emitText(block);
          continue;
        }

        const endMarker = next.marker === XML_START ? XML_END : ALT_END;
        const end = pendingText.indexOf(endMarker, next.marker.length);
        if (end < 0) {
          if (final) pendingText = "";
          return;
        }
        const block = pendingText.slice(0, end + endMarker.length);
        rawToolMarkup.push(block);
        pendingText = pendingText.slice(end + endMarker.length);
      }
    };

    try {
      for await (const part of streamResult.stream) {
        context.onStream({
          type: part.type,
          ...(part.type === "text-delta" || part.type === "reasoning-delta"
            ? { text: part.text }
            : {}),
          ...(part.type === "tool-call"
            ? {
                toolCallId: part.toolCallId,
                toolName: part.toolName,
              }
            : {}),
          ...(part.type === "error"
            ? { error: streamErrorText(part.error) }
            : {}),
        });
        if (part.type === "text-delta") {
          rawText += part.text;
          pendingText += part.text;
          drainText(false);
        } else if (part.type === "error") {
          providerError = streamErrorText(part.error);
        } else if (part.type === "finish") {
          finishReason = part.finishReason;
        } else if (
          part.type === "tool-call" ||
          part.type === "tool-input-start"
        ) {
          nativeTools = true;
          toolsProduced = true;
          const name =
            "toolName" in part ? String(part.toolName || "") : "tool";
          const input =
            "input" in part && part.input !== undefined
              ? JSON.stringify(part.input)
              : undefined;
          roundSignatures.push(`${name}:${input || ""}`.slice(0, 800));
          const parsedInput = input ? parseToolInput(input) : {};
          const displayName = innerToolName(name, parsedInput);
          const todos = todosFromToolPayload(input);
          const kind = classifyToolKind(displayName || name, parsedInput);
          const subagent = subagentMetadataFromTool(
            displayName || name,
            parsedInput,
            undefined,
            kind,
          );
          context.onTool({
            id:
              "toolCallId" in part
                ? String(part.toolCallId)
                : crypto.randomUUID(),
            name: displayName || name,
            status: "running",
            kind,
            ...(typeof parsedInput.path === "string"
              ? { path: parsedInput.path }
              : {}),
            ...(input ? { input } : {}),
            ...(todos?.length ? { todos } : {}),
            ...(subagent ? { subagent } : {}),
          });
        } else if (part.type === "tool-result") {
          nativeTools = true;
          toolsProduced = true;
          const resultText =
            "output" in part && part.output !== undefined
              ? JSON.stringify(part.output)
              : "result" in part && part.result !== undefined
                ? JSON.stringify(part.result)
                : undefined;
          roundSignatures.push(
            `${String(part.toolName)}:${resultText || ""}`.slice(0, 800),
          );
          const displayName = innerToolName(
            part.toolName,
            undefined,
            resultText,
          );
          const todos = todosFromToolPayload(undefined, resultText);
          const kind = classifyToolKind(
            displayName || part.toolName,
            undefined,
            resultText,
          );
          const subagent = subagentMetadataFromTool(
            displayName || part.toolName,
            undefined,
            resultText,
            kind,
          );
          context.onTool({
            id: part.toolCallId,
            name: displayName || part.toolName,
            status: "completed",
            kind,
            ...(resultText ? { result: resultText } : {}),
            ...(todos?.length ? { todos } : {}),
            ...(subagent ? { subagent } : {}),
          });
        }
      }
      drainText(true);
    } catch (error) {
      const message = streamErrorText(error);
      context.onStream({ type: "error", error: message });
      throw new Error(message);
    }

    let executions: EmbeddedToolExecution[] = [];
    // Native tool-call parts already ran inside streamText. Do not execute the
    // same calls again just because the transcript also contained XML/JSON.
    if (!nativeTools && rawToolMarkup.length) {
      executions = await executeEmbeddedToolFallbacks(
        rawToolMarkup.join("\n"),
        async (call, index) => {
          const candidate = fallbackTools[call.name] as unknown as
            | {
                execute?: (
                  args: Record<string, unknown>,
                  options: Record<string, unknown>,
                ) => Promise<unknown> | unknown;
              }
            | undefined;
          if (!candidate?.execute)
            throw new Error(
              `Embedded tool ${call.name} is not available in this mode.`,
            );
          const callId = `fallback-${context.job.id}-${fallbackIndex + index}`;
          const input = JSON.stringify(call.args);
          const displayName = innerToolName(call.name, call.args);
          const kind = classifyToolKind(displayName || call.name, call.args);
          const inputTodos = todosFromToolPayload(input);
          context.onTool({
            id: callId,
            name: displayName || call.name,
            status: "running",
            kind,
            ...(typeof call.args.path === "string"
              ? { path: call.args.path }
              : {}),
            input,
            ...(inputTodos?.length ? { todos: inputTodos } : {}),
          });
          try {
            const output = await candidate.execute(call.args, {
              toolCallId: callId,
              messages: conversation,
              abortSignal: context.signal,
              context: undefined,
            });
            const resultText =
              typeof output === "string" ? output : JSON.stringify(output);
            const resultTodos = todosFromToolPayload(input, resultText);
            context.onTool({
              id: callId,
              name: displayName || call.name,
              status: "completed",
              kind,
              input,
              ...(resultText ? { result: resultText } : {}),
              ...(resultTodos?.length ? { todos: resultTodos } : {}),
            });
            return output;
          } catch (error) {
            const message = streamErrorText(error);
            context.onTool({
              id: callId,
              name: displayName || call.name,
              status: "error",
              kind,
              input,
              result: message,
            });
            throw error;
          }
        },
      );
      if (executions.length) toolsProduced = true;
      const failed = executions.find((execution) => !execution.ok);
      if (failed)
        throw new Error(failed.error || `Embedded tool ${failed.name} failed.`);
      fallbackIndex += executions.length;
    }

    let roundUsage;
    try {
      roundUsage = await streamResult.usage;
    } catch (error) {
      const message = streamErrorText(error);
      context.onStream({ type: "error", error: message });
      throw new Error(providerError || message);
    }
    if (providerError) throw new Error(providerError);
    addUsage(roundUsage);
    void rawText;
    const steps = await Promise.resolve(streamResult.steps)
      .then((value) => value)
      .catch(() => []);
    return {
      executions,
      nativeTools,
      visibleText,
      signature: roundSignatures.sort().join("|"),
      stepCount: Math.max(1, steps.length),
    };
  };

  while (remainingSteps > 0) {
    const round = await consumeRound(current);
    remainingSteps -= round.stepCount;
    const loop = loopGuard.observe({
      signature: round.signature,
      progressed: Boolean(round.visibleText.trim() || round.executions.length),
      failed: false,
    });
    if (loop.shouldStop) {
      throw new Error(
        `Provider agent loop stopped: ${loop.reason || "no progress"}.`,
      );
    }
    if (!round.executions.length || !resumeEmbedded || remainingSteps <= 0)
      break;
    conversation = [
      ...conversation,
      {
        role: "assistant",
        content: [
          ...(round.visibleText.trim()
            ? [{ type: "text" as const, text: round.visibleText }]
            : []),
          ...round.executions.map((execution, index) => ({
            type: "tool-call" as const,
            toolCallId: `fallback-${context.job.id}-${fallbackIndex - round.executions.length + index}`,
            toolName: execution.name,
            input: execution.args,
          })),
        ],
      },
      {
        role: "tool",
        content: round.executions.map((execution, index) => ({
          type: "tool-result" as const,
          toolCallId: `fallback-${context.job.id}-${fallbackIndex - round.executions.length + index}`,
          toolName: execution.name,
          output: execution.ok
            ? {
                type: "text" as const,
                value:
                  typeof execution.result === "string"
                    ? execution.result
                    : JSON.stringify(execution.result ?? ""),
              }
            : {
                type: "error-text" as const,
                value: execution.error || "Tool failed.",
              },
        })),
      },
    ];
    const compactedConversation = compactIfNeeded(
      conversation,
      resolvedContextWindow(context),
      contextModeOf(effectiveModelParams(context.chat, context.job)),
    );
    current = resumeEmbedded(compactedConversation, remainingSteps);
  }

  if (!textProduced && !toolsProduced) {
    const suffix = finishReason ? ` (finish reason: ${finishReason})` : "";
    throw new Error(`Provider returned no text output${suffix}.`);
  }
  if (!textProduced && toolsProduced) {
    context.onText("The provider finished its tool work.");
  }
  return usage;
}

export function providerMcpContext(
  context: ProviderContext,
  options: { runtimeApprovalGate?: boolean } = {},
) {
  const mode = modeById(
    context.job.modeId || context.chat.sessionState?.modeId,
  );
  return buildMcpContext({
    chatId: context.job.chatId,
    userId: context.job.userId,
    jobId: context.job.id,
    incognito: Boolean(context.job.incognito),
    automation: Boolean(context.job.automationId),
    modeId: mode.id,
    runtimeMode:
      options.runtimeApprovalGate === false
        ? "full-access"
        : runtimeModeForChat(context.chat),
    modePolicy: {
      allowedCategories: mode.allowedCategories,
      toolOverrides: mode.toolOverrides || {},
    },
    workspaceId: context.job.chatId,
    attemptId: context.job.runId || context.job.id,
    policyVersion: `mode:${mode.id}:v1`,
    allowedCategories: mode.allowedCategories,
    toolOverrides: mode.toolOverrides || {},
    childMcpGrants: { "*": ["*"] },
  });
}

export function stdioGatewayConfig(
  gateway:
    | {
        type: "stdio";
        command: string;
        args: string[];
        cwd: string;
        env: Record<string, string>;
      }
    | {
        type: "http";
        url: string;
        headers?: Record<string, string> | undefined;
      },
) {
  if (gateway.type === "http") {
    return {
      command: "npx",
      args: ["-y", "mcp-remote", gateway.url],
      env: {} as Record<string, string>,
    };
  }
  return { command: gateway.command, args: gateway.args, env: gateway.env };
}

export function modeMcpEnv(context: ProviderContext): Record<string, string> {
  // The AI-SDK/custom-provider harness executes Metis tools through its own
  // internal MCP bridge. It needs the full trusted per-run environment even
  // when native runtimes use the signed Streamable-HTTP MCP endpoint.
  return getMcpBridgeEnv(providerMcpContext(context));
}

export async function agentToolsFor(context: ProviderContext): Promise<ToolSet> {
  const env = modeMcpEnv(context);
  try {
    return await mcpBridgeTools(env);
  } catch (first) {
    try {
      return await mcpBridgeTools({
        ...env,
        MCP_GATEWAY_RETRY: String(Date.now()),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const previous = first instanceof Error ? first.message : String(first);
      throw new Error(
        `MCP gateway tools unavailable after retry (${detail}). First error: ${previous}`,
      );
    }
  }
}
