import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { jsonSchema, stepCountIs, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
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
import { buildAttachmentPrompt, visionImagesForAttachments } from "@/lib/uploads";
import { config } from "@/lib/config";
import { mcpBridgeTools } from "@/lib/mcp-bridge";
import { getUserAgentCwd, getMcpServers, buildMcpContext } from "@/lib/mcp";
import {
  findActiveConnection,
  getProviderConnection,
  getProviderConnectionSecret,
  updateProviderConnection,
  type ProviderConnectionWithSecret,
} from "@/lib/provider-connections";
import { getProviderDefinition } from "@/lib/providers/registry";
import { providerExecution } from "@/lib/providers/run-kind";
import { normalizeLegacyProviderModelId } from "@/lib/providers/model-aliases";
import { modelKey, parseModelKey } from "@/lib/providers/types";
import {
  createOAuthProvider,
  ensureAntigravityProjectId,
  type OAuthProviderKey,
} from "@/lib/providers/oauth";
import { antigravitySupportsEffort, runAntigravitySdkJob, runOfficialAntigravityJob } from "@/lib/providers/official-antigravity";
import { canonicalizeToolPart } from "@/lib/providers/tool-events";
import { runAcpStdioAgent } from "@/lib/providers/acp-stdio";
import type { AgentJob } from "@/lib/jobs";
import { allModes, modeById } from "@/lib/modes";
import { classifyToolKind, innerToolName, todosFromToolPayload } from "@/lib/tool-call-display";
import { classifyTool, resolveMcpToolName, toolDetailFromArgs } from "@/lib/tool-kind";
import { metisAgentIdentity } from "@/lib/agent-identity";
import { compress } from "@/lib/compression";
import {
  contextModeOf,
  CONTEXT_COMPACT_RATIO,
 effectiveContextBudget,
  estimateContextTokens,
  type ContextMode,
  contextWindowForSelection,
  lastMeasuredInputTokens,
} from "@/lib/context-window";
import { logError } from "@/lib/error-logs";
import { persistToolsForMessage } from "@/lib/tool-persistence";
import { stripRawToolMarkup } from "@/lib/providers/tool-schema";
import { executeEmbeddedToolFallbacks, type EmbeddedToolExecution } from "@/lib/providers/embedded-tool-fallback";
import { subagentMetadataFromTool } from "@/lib/subagent-tool";
import { METIS_SHARED_AGENT_CONTROL, toolContractPrompt } from "@/lib/agent-control";
import { recordSignal, type TaskCategory } from "@/lib/model-telemetry";
import { LoopGuard, routeTask } from "@/lib/agent-efficiency";

type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

type ProviderResult = {
  agentId?: string;
  usage?: Usage;
};

type ProviderContext = {
  job: AgentJob;
  chat: Chat;
  connection: ProviderConnectionWithSecret;
  modelId: string;
  signal: AbortSignal;
  onText: (value: string) => void;
  onTool: (tool: ToolPart) => void;
  onThinking: (data: { text?: string; replace?: boolean; done?: boolean; durationMs?: number }) => void;
  onStream: (data: Record<string, unknown>) => void;
 onCompaction: (event: CompactionEvent) => void;
};

function telemetryCategory(message: string): TaskCategory {
  const text = String(message || "");
  if (/\b(debug|bug|error|crash|fehler|kaputt)\b/i.test(text)) return "debugging";
  if (/\b(implement|build|edit|fix|refactor|code|änder|baue|umsetzen)\b/i.test(text)) return "coding";
  if (/\b(research|analyse|analyze|recherch|dokumentation|prüf)\b/i.test(text)) return "research";
  if (text.length > 2_500) return "long-context";
  return "chat";
}

function finalizeAlternativeTools(tools: ToolPart[]) {
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
    target: { type: "string", description: "server or client:<remote-client-id>" },
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

function providerRemoteTools(context: ProviderContext): ToolSet {
  const mode = modeById(context.job.modeId || context.chat.sessionState?.modeId);
  const canWrite = mode.allowedCategories.includes("write");
  const canRemote = mode.allowedCategories.includes("remote");
  if (!canRemote) return {};
  const call = async (action: string, args: Record<string, unknown> = {}) => {
    const clientId = typeof args.target === "string" && args.target.startsWith("client:")
      ? args.target.slice("client:".length).trim()
      : typeof args.client_id === "string" ? args.client_id : "";
    if (action === "list_remote_clients") {
      const response = await fetch(
        process.env.AI_CHAT_INTERNAL_REMOTE_CLIENT_URL || `http://127.0.0.1:${process.env.PORT || "3100"}/api/internal/remote-client`,
        { headers: { Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "")}`, "X-AI-Chat-User-Id": String(context.job.userId || "") } },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Failed to list remote clients");
      return body.clients || [];
    }
    if (!clientId) throw new Error("target must be client:<remote-client-id>");
    const response = await fetch(
      process.env.AI_CHAT_INTERNAL_REMOTE_CLIENT_URL || `http://127.0.0.1:${process.env.PORT || "3100"}/api/internal/remote-client`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${String(process.env.MCP_BEARER_TOKEN || "")}`,
          "X-AI-Chat-User-Id": String(context.job.userId || ""),
        },
        body: JSON.stringify({ clientId, action, params: args, source: "agent" }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Remote ${action} failed`);
    return body.result;
  };
  const remoteTool = (
    description: string,
    execute: (args: Record<string, unknown>) => Promise<unknown>,
  ) => tool({
    description,
    inputSchema: remoteToolSchema,
    execute,
  } as never) as ToolSet[string];
  const tools: ToolSet = {
    list_remote_clients: remoteTool("List all connected remote clients and their status.", () => call("list_remote_clients")),
    read_file: remoteTool("Read a UTF-8 file from a remote client.", (args) => call("read_file", args)),
    list_directory: remoteTool("List a directory on a remote client.", (args) => call("list_directory", args)),
    execute_command: remoteTool("Run a command on a remote client.", (args) => call("execute_command", args)),
  };
  if (canWrite) {
    tools.write_file = remoteTool("Create or overwrite a UTF-8 file on a remote client.", (args) => call("write_file", args));
    tools.edit_file = remoteTool("Replace oldText with newText in a remote client file.", (args) => call("edit_file", args));
    tools.delete_file = remoteTool("Delete a file on a remote client.", (args) => call("delete_file", args));
  }
  return tools;
}

function providerLanguageTools(context: ProviderContext): ToolSet {
  const tools: ToolSet = { ...providerRemoteTools(context) };
  Object.assign(tools, providerNativeSearchTools(context));
  return tools;
}

function providerNativeSearchTools(context: ProviderContext): ToolSet {
  if (context.connection.providerKey !== "xai") return {};
  const client = createXai({
    apiKey: context.connection.secret,
    ...(context.connection.baseUrl ? { baseURL: context.connection.baseUrl } : {}),
  });
  return {
    web_search: client.tools.webSearch() as never,
    x_search: client.tools.xSearch() as never,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function inheritedEnv(extra: Record<string, string | undefined> = {}) {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...extra })
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function providerTaskMessage(job: AgentJob) {
  return job.resumePrompt?.trim() || job.message || "Continue the current task without repeating completed work.";
}

function providerPrompt(
  job: AgentJob,
  toolNames?: ReadonlyArray<string>,
  nativeTools = false,
  modelParams?: ReadonlyArray<{ id: string; value: string }> | null,
) {
  const references = job.references?.length
    ? job.references.map((reference) => [
        `- [${reference.kind}] ${reference.label}`,
        reference.detail ? `  Detail: ${reference.detail}` : "",
        reference.path ? `  Path/URL: ${reference.path}` : "",
        reference.content ? `  Context:\n${reference.content}` : "",
      ].filter(Boolean).join("\n")).join("\n")
    : "";
  const chat = getChat(job.chatId, job.userId);
  const project = chat?.projectId ? getProject(chat.projectId, job.userId) : null;
  const prompt = [
    metisAgentIdentity(),
    project ? projectContextBlock(project, job.userId) : "",
    skillsCatalogPrompt(getGlobalModelSettings(job.userId)),
    "Working style: precise, technically fluent, proactive. Act with your tools instead of describing steps. Reply in the user's language — German in, German out. No filler phrases. On clear orders decide and act yourself; ask back only when genuinely ambiguous or destructive.",
    "Answer the user directly and do not claim to have used tools you were not given.",
    "This is a Metis-branded tool surface: prefer the attached Metis MCP gateway tools, execute them silently, and never paste raw tool/MCP dumps into the user-visible reply.",
    "If web_search or x_search are available, use them for current documentation or facts instead of narrating that you are researching.",
    METIS_SHARED_AGENT_CONTROL,
    toolContractPrompt({
      modeId: job.modeId || "agent",
      provider: "alternative-provider",
      toolNames,
      nativeTools,
    }),
    "Response recommendation rule: when the result is incomplete, uses demo/stub endpoints, or still lacks real integrations, clearly distinguish implemented from missing functionality, then provide 1–3 concise, concrete next-step recommendations and ask whether to implement the recommended next step. Never present demo functionality as production-ready.",
    "Remote-client tools are available in this run when supported by the provider. Use list_remote_clients first, then target remote operations with target=client:<remote-client-id>; do not use server paths for client files.",
    "Browser: for login, forms, captchas, checkouts, and long page tasks ALWAYS use the persistent Metis in-app browser (browser_navigate, browser_form_state, browser_batch, browser_wait_for, browser_fill_form, browser_snapshot). Inspect the current state first; navigate only when the URL actually needs to change, and never reload or re-login merely to inspect progress. browser_form_state and browser_extract_text include embedded frames and return frame hints/selectors. Batch repetitive actions and wait on DOM conditions instead of sleeps. Do not use shell, curl, Playwright, or web_fetch as a substitute when a real page is needed. web_search/web_fetch are only for simple lookup.",
    "When you use browser results, selected references, or other verifiable web sources, cite the exact URL immediately after the sentence it supports using the format [Source: Website title](URL). At the end, put every source used in exactly one fenced block starting with ```sources, with one Markdown link per line. Never invent URLs; if no verifiable source is available, do not create a sources block.",
"Personal context: the context_search / context_profile / context_remember tools, when available in this run, access the owner's shared context hub (devices, services, projects, preferences). When a task touches the owner's infrastructure, projects, or devices, consult them FIRST instead of asking the user. Do not dump contents unprompted; cite only what the query returned. Store newly learned durable preferences (how the owner wants things) via context_remember.",
    references ? `Selected references:\n${references}` : "",
    job.referenceText ? `Referenced context:\n${job.referenceText}` : "",
    buildAttachmentPrompt(job.chatId, job.attachments),
  ].filter(Boolean).join("\n\n");
  return prompt;
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
  return message.content.map((part) => {
    if (!part || typeof part !== "object") return String(part ?? "");
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }).join("\n");
}

function stripProviderReasoning(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || typeof message.content === "string") return message;
    return {
      ...message,
      content: message.content.filter((part) => part.type !== "reasoning"),
    };
  });
}

function chatToModelMessages(chat: Chat, excludeMessageId?: string): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const message of chat.messages) {
    if (excludeMessageId && message.id === excludeMessageId) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = message.content.trim();
    const tools = message.tools || [];
    const images = message.role === "user" && message.attachments?.length
      ? visionImagesForAttachments(chat.id, message.attachments, chat.ownerId)
      : [];
    if (!content && !tools.length && !images.length) continue;
    if (message.role === "user") {
      if (!images.length) {
        messages.push({ role: "user", content: content || "respond." });
      } else {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: content || "See attached image(s)." },
            ...images.map((image) => ({
              type: "image" as const,
              image: `data:${image.mimeType};base64,${image.data}`,
              mediaType: image.mimeType,
            })),
          ],
        });
      }
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
        output: item.status === "error"
          ? { type: "error-text" as const, value: item.result || item.status }
          : { type: "text" as const, value: item.result || item.status },
      })),
    });
  }
  return messages;
}

function serializeModelMessagesForPrompt(messages: ModelMessage[]): string {
  const blocks: string[] = [];
  for (const message of messages) {
    const text = modelMessageText(message).trim();
    if (!text) continue;
    const speaker = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "Tool";
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
    measuredTokens?: number;
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
    options.measuredTokens,
  );
  let text = serializeModelMessagesForPrompt(next);
  const maxChars = options.maxChars ?? 120_000;
  if (text.length > maxChars) {
    text = `[Earlier persisted messages truncated to fit the model context]\n${text.slice(-maxChars)}`;
  }
  return { text, compacted };
}

function modelMessages(
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
  return compactIfNeeded(messages, contextWindow, contextMode, onCompaction, lastMeasuredInputTokens(chat));
}

function effectiveModelParams(chat: Chat, job: AgentJob) {
  return job.modelParams?.length ? job.modelParams : chat.modelParams;
}

function estimateProviderInputTokens(chat: Chat, job: AgentJob, modelId: string) {
  const contextWindow = contextWindowForSelection(
    { id: modelId, providerId: parseModelKey(job.modelId).providerKey },
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
  return Math.max(1, estimateContextTokens({
    instructions: providerPrompt(job),
    messages,
  }));
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
function resolvedContextWindow(context: ProviderContext): number | undefined {
  try {
    return contextWindowForSelection(
      { id: context.modelId, providerId: context.connection.providerKey },
      effectiveModelParams(context.chat, context.job),
    );
  } catch {
    return undefined;
  }
}

function providerConversationPrompt(context: ProviderContext): string {
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
  ].filter(Boolean).join("\n\n");
}

function compactMessageRecap(message: ModelMessage): string {
  const text = modelMessageText(message);
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return `${message.role}: ${text}`;
  }
  const tools: ToolPart[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object" || !("type" in part) || part.type !== "tool-call") continue;
    tools.push({
      id: String("toolCallId" in part ? part.toolCallId : ""),
      name: String("toolName" in part ? part.toolName : "tool"),
      status: "completed",
      input: typeof ("input" in part ? part.input : undefined) === "string"
        ? String(part.input)
        : JSON.stringify("input" in part ? part.input ?? {} : {}),
    });
  }
  const recap = tools.length ? `\nTools already executed:\n${toolRecap(tools)}` : "";
  return `${message.role}: ${text}${recap}`;
}

function toolRecap(tools: ToolPart[]) {
  return tools.map((item) => {
    const input = item.input ? ` input=${item.input.slice(0, 400)}` : "";
    const result = item.result && item.kind !== "read" ? ` result=${item.result.slice(0, 800)}` : "";
    return `- ${item.name} (${item.status})${item.path ? ` path=${item.path}` : ""}${input}${result}`;
  }).join("\n");
}

const COMPACTION_MARKER = "[metis-context-recap:v1]";

function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 32) return value.slice(0, maxChars);
  const tail = Math.floor(maxChars * 0.25);
  return `${value.slice(0, maxChars - tail - 32)} … [truncated] … ${value.slice(-tail)}`;
}

function compactIfNeeded(
  messages: ModelMessage[],
  contextWindow?: number,
  contextMode: ContextMode = "normal",
  onCompaction?: (event: CompactionEvent) => void,
  measuredTokens?: number,
): ModelMessage[] {
  if (!contextWindow || contextWindow <= 0 || messages.length < 2) return messages;
  const total = messages.reduce((sum, message) => sum + estimateContextTokens(message), 0);
  const budget = effectiveContextBudget(contextWindow, contextMode);
  const pressureTokens = Math.max(total, Number(measuredTokens) > 0 ? Number(measuredTokens) : 0);
  if (pressureTokens / contextWindow < CONTEXT_COMPACT_RATIO) return messages;
 // One compact per pressure wave. A recap is already canonical; compacting it
 // again would drop the tail and break idempotency on the next runner step.
 if (messages.some((message) => modelMessageText(message).includes(COMPACTION_MARKER))) {
   return messages;
 }

  // A prior recap is already canonical. Re-summarizing it would make repeated
  // compaction non-idempotent and can slowly erase the original task.
  const head = messages.filter((message) => !modelMessageText(message).includes(COMPACTION_MARKER));
  const source = head.length === messages.length ? messages : messages.slice(-Math.max(2, Math.floor(messages.length * 0.45)));
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
    { role: "user", content: `${recapPrefix}${boundedText(recap, recapBudget)}` },
    ...protectedTail,
  ];
  // A single giant tool result can fill the protected tail by itself. Bound
  // every message until the measured payload is within the effective budget.
  let trimPasses = 0;
  const maxTrimPasses = Math.max(8, result.length * 4);
  while (result.reduce((sum, message) => sum + estimateContextTokens(message), 0) > budget && result.length > 1) {
    const excess = result.reduce((sum, message) => sum + estimateContextTokens(message), 0) - budget;
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
  if (result.reduce((sum, message) => sum + estimateContextTokens(message), 0) > budget) {
    const last = result.at(-1);
    result = [{
      role: "user",
      content: `${recapPrefix}${boundedText(recap, Math.max(32, (budget - estimateContextTokens(last || "") - 2) * 4))}`,
    }, ...(last ? [{ role: last.role, content: boundedText(modelMessageText(last), Math.max(32, (budget - 2) * 4)) } as ModelMessage] : [])];
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
    afterTokens: result.reduce((sum, message) => sum + estimateContextTokens(message), 0),
    removedMessages: oldMessages.length,
  });
  return result;
}

export function compactProviderMessages(
  messages: ModelMessage[],
  contextWindow: number,
  contextMode: ContextMode = "normal",
  onCompaction?: (event: CompactionEvent) => void,
  measuredTokens?: number,
): ModelMessage[] {
  return compactIfNeeded(messages, contextWindow, contextMode, onCompaction, measuredTokens);
}

export function codexReasoningEffortForSelection(
  modelId: string,
  params?: ReadonlyArray<{ id: string; value: string }> | null,
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (!/^(?:gpt[-_.]?5|codex)/i.test(modelId.trim())) return undefined;
  const value = params?.find((param) => param.id === "effort" || param.id === "reasoning")?.value;
  return value && ["minimal", "low", "medium", "high", "xhigh"].includes(value)
    ? value as "minimal" | "low" | "medium" | "high" | "xhigh"
    : undefined;
}

export function aiReasoningForSelection(
  providerKey: string,
  params?: ReadonlyArray<{ id: string; value: string }> | null,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  const value = params?.find((param) => param.id === "effort" || param.id === "reasoning")?.value;
  if (!value) return providerKey === "codex" ? "none" : undefined;
  const allowed = providerKey === "anthropic" || providerKey === "google"
    ? ["none", "low", "medium", "high"]
    : ["none", "minimal", "low", "medium", "high", "xhigh"];
  return allowed.includes(value)
    ? value as "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
    : undefined;
}

function aiModel(
  providerKey: string,
  modelId: string,
  connection: ProviderConnectionWithSecret,
): LanguageModel {
  const secret = connection.secret;
  const baseURL = connection.baseUrl;
  if (providerKey === "openai" || (providerKey === "codex" && connection.authType === "api_key")) {
    return createOpenAI({ apiKey: secret, ...(baseURL ? { baseURL } : {}) }).chat(modelId);
  }
  if (providerKey === "anthropic") {
    return createAnthropic({ apiKey: secret, ...(baseURL ? { baseURL } : {}) }).messages(modelId);
  }
  if (providerKey === "google") {
    if (connection.authType === "vertex_adc") {
      return createGoogleVertex({
        project: typeof connection.config.project === "string"
          ? connection.config.project
          : undefined,
        location: typeof connection.config.location === "string"
          ? connection.config.location
          : undefined,
      }).languageModel(modelId);
    }
    return createGoogle({ apiKey: secret, ...(baseURL ? { baseURL } : {}) }).chat(modelId);
  }
  if (providerKey === "xai") {
    return createXai({ apiKey: secret, ...(baseURL ? { baseURL } : {}) }).responses(modelId);
  }
  if (providerKey === "openrouter") {
    return createOpenRouter({
      apiKey: secret,
      ...(baseURL ? { baseUrl: baseURL } : {}),
    }).chat(modelId);
  }
  if (providerKey === "ollama" || providerKey === "compatible") {
    if (!baseURL) throw new Error("An OpenAI-compatible connection requires a base URL.");
    return createOpenAICompatible({
      name: `${providerKey}-${connection.id}`,
      baseURL,
      ...(secret ? { apiKey: secret } : {}),
    }).chatModel(modelId);
  }
  throw new Error(`Provider ${providerKey} is not a chat API provider.`);
}

export function anthropicProviderOptionsForSelection(
  modelId: string,
  params?: ReadonlyArray<{ id: string; value: string }> | null,
) {
  const selectedWindow = contextWindowForSelection({ id: modelId, providerId: "anthropic" }, params);
  if (selectedWindow !== 1_000_000) return undefined;
  if (!/claude-(?:sonnet|opus)-(?:4(?:-|$)|4\.5(?:[-.]|$))/i.test(modelId)) return undefined;
  return {
    anthropic: {
      anthropicBeta: ["context-1m-2025-08-07"],
    },
  };
}

function providerOptionsFor(context: ProviderContext) {
  if (context.connection.providerKey !== "anthropic") return undefined;
  return anthropicProviderOptionsForSelection(context.modelId, effectiveModelParams(context.chat, context.job));
}

function streamErrorText(value: unknown) {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const DEFAULT_PROVIDER_STEPS = 50;

async function consumeAiStream(
  result: ReturnType<typeof streamText>,
  context: ProviderContext,
  fallbackTools: ToolSet,
  initiatingMessages: ModelMessage[],
  resumeEmbedded?: (messages: ModelMessage[], remainingSteps: number) => ReturnType<typeof streamText>,
  initialSteps = DEFAULT_PROVIDER_STEPS,
) {
  let textProduced = false;
  let toolsProduced = false;
  let finishReason = "";
  let conversation = initiatingMessages;
  let current = result;
  let remainingSteps = Math.max(1, Math.min(DEFAULT_PROVIDER_STEPS * 2, Math.floor(initialSteps)));
  const loopGuard = new LoopGuard();
  let fallbackIndex = 0;
  const usage: Usage = {};

  const addUsage = (part: { inputTokens?: number; outputTokens?: number; totalTokens?: number }) => {
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
        } else if (part.type === "tool-call" || part.type === "tool-input-start") {
          nativeTools = true;
          toolsProduced = true;
          const name = "toolName" in part ? String(part.toolName || "") : "tool";
          const input = "input" in part && part.input !== undefined ? JSON.stringify(part.input) : undefined;
          roundSignatures.push(`${name}:${input || ""}`.slice(0, 800));
          const parsedInput = input ? parseToolInput(input) : {};
          const displayName = innerToolName(name, parsedInput);
          const todos = todosFromToolPayload(input);
          const kind = classifyToolKind(displayName || name, parsedInput);
          const subagent = subagentMetadataFromTool(displayName || name, parsedInput, undefined, kind);
          context.onTool({
            id: "toolCallId" in part ? String(part.toolCallId) : crypto.randomUUID(),
            name: displayName || name,
            status: "running",
            kind,
            ...(typeof parsedInput.path === "string" ? { path: parsedInput.path } : {}),
            ...(input ? { input } : {}),
            ...(todos?.length ? { todos } : {}),
            ...(subagent ? { subagent } : {}),
          });
        } else if (part.type === "tool-result") {
          nativeTools = true;
          toolsProduced = true;
          const resultText = "output" in part && part.output !== undefined
            ? JSON.stringify(part.output)
            : "result" in part && part.result !== undefined
              ? JSON.stringify(part.result)
              : undefined;
          roundSignatures.push(`${String(part.toolName)}:${resultText || ""}`.slice(0, 800));
          const displayName = innerToolName(part.toolName, undefined, resultText);
          const todos = todosFromToolPayload(undefined, resultText);
          const kind = classifyToolKind(displayName || part.toolName, undefined, resultText);
          const subagent = subagentMetadataFromTool(displayName || part.toolName, undefined, resultText, kind);
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
          const candidate = fallbackTools[call.name] as unknown as {
            execute?: (args: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown> | unknown;
          } | undefined;
          if (!candidate?.execute) throw new Error(`Embedded tool ${call.name} is not available in this mode.`);
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
            ...(typeof call.args.path === "string" ? { path: call.args.path } : {}),
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
            const resultText = typeof output === "string" ? output : JSON.stringify(output);
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
      if (failed) throw new Error(failed.error || `Embedded tool ${failed.name} failed.`);
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
    const steps = await Promise.resolve(streamResult.steps).then((value) => value).catch(() => []);
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
      throw new Error(`Provider agent loop stopped: ${loop.reason || "no progress"}.`);
    }
    if (!round.executions.length || !resumeEmbedded || remainingSteps <= 0) break;
    conversation = [
      ...conversation,
      {
        role: "assistant",
        content: [
          ...(round.visibleText.trim() ? [{ type: "text" as const, text: round.visibleText }] : []),
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
                value: typeof execution.result === "string"
                  ? execution.result
                  : JSON.stringify(execution.result ?? ""),
              }
            : { type: "error-text" as const, value: execution.error || "Tool failed." },
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

function providerMcpContext(context: ProviderContext) {
  const mode = modeById(context.job.modeId || context.chat.sessionState?.modeId);
  return buildMcpContext({
    chatId: context.job.chatId,
    userId: context.job.userId,
    jobId: context.job.id,
    incognito: Boolean(context.job.incognito),
    automation: Boolean(context.job.automationId),
    modeId: mode.id,
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


function stdioGatewayConfig(gateway: { type: "stdio"; command: string; args: string[]; cwd: string; env: Record<string, string> } | { type: "http"; url: string; headers?: Record<string, string> | undefined }) {
  if (gateway.type === "http") {
    return { command: "npx", args: ["-y", "mcp-remote", gateway.url], env: {} as Record<string, string> };
  }
  return { command: gateway.command, args: gateway.args, env: gateway.env };
}

function modeMcpEnv(context: ProviderContext): Record<string, string> {
  const gateway = getMcpServers(providerMcpContext(context)).gateway;
  return gateway.type === "http" ? {} : gateway.env;
}

async function agentToolsFor(context: ProviderContext): Promise<ToolSet> {
  const env = modeMcpEnv(context);
  try {
    return await mcpBridgeTools(env);
  } catch (first) {
    try {
      return await mcpBridgeTools({ ...env, MCP_GATEWAY_RETRY: String(Date.now()) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const previous = first instanceof Error ? first.message : String(first);
      throw new Error(`MCP gateway tools unavailable after retry (${detail}). First error: ${previous}`);
    }
  }
}

async function runAiSdk(context: ProviderContext): Promise<ProviderResult> {
  const tools = {
    ...(await agentToolsFor(context)),
    ...providerNativeSearchTools(context),
  };
  const messages = modelMessages(
    context.chat,
    context.job,
    resolvedContextWindow(context),
    contextModeOf(effectiveModelParams(context.chat, context.job)),
    context.onCompaction,
  );
  const route = routeTask(context.job.message);
  const stream = (nextMessages: ModelMessage[], remainingSteps: number) => streamText({
    model: aiModel(context.connection.providerKey, context.modelId, context.connection),
    instructions: providerPrompt(context.job, Object.keys(tools), false, effectiveModelParams(context.chat, context.job)),
    messages: nextMessages,
    tools,
    reasoning: aiReasoningForSelection(context.connection.providerKey, effectiveModelParams(context.chat, context.job)),
    providerOptions: providerOptionsFor(context),
    stopWhen: stepCountIs(remainingSteps),
    prepareStep: ({ messages }) => ({ messages: stripProviderReasoning(messages) }),
    abortSignal: context.signal,
  });
  return {
    usage: await consumeAiStream(stream(messages, route.initialSteps), context, tools, messages, stream, route.initialSteps),
  };
}

async function runOAuthAiSdk(
  context: ProviderContext,
  providerKey: OAuthProviderKey,
): Promise<ProviderResult> {
  if (!context.connection.secret) {
    throw new Error("OAuth connection is not completed yet. Connect the provider first.");
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-chat-oauth-run-"));
  const authFile = path.join(tempDir, "oauth.json");
  let authPayload = context.connection.secret;
  if (providerKey === "antigravity") {
    try {
      const parsed = JSON.parse(authPayload) as Record<string, unknown>;
      const token = parsed.token && typeof parsed.token === "object"
        ? parsed.token as Record<string, unknown>
        : undefined;
      if (token && typeof token.access_token === "string" && typeof token.refresh_token === "string") {
        const expiry = typeof token.expiry === "string" ? Date.parse(token.expiry) : NaN;
        authPayload = JSON.stringify({
          "google-gemini-cli": {
            type: "oauth",
            access: token.access_token,
            refresh: token.refresh_token,
            expires: Number.isFinite(expiry) ? expiry : Date.now() + 3_600_000,
            ...(typeof context.connection.config.project === "string"
              ? { projectId: context.connection.config.project }
              : {}),
          },
        });
      }
    } catch {
      // The provider-specific OAuth adapter will report malformed credentials.
    }
  }
  await writeFile(authFile, authPayload, { encoding: "utf8", mode: 0o600 });
  try {
    if (providerKey === "antigravity") {
      await ensureAntigravityProjectId(
        authFile,
        typeof context.connection.config.project === "string"
          ? context.connection.config.project
          : undefined,
      );
    }
    const provider = await createOAuthProvider(providerKey, authFile);
    const oauthModelId = context.modelId;
    const oauthTools = {
      ...(await agentToolsFor(context)),
      ...providerNativeSearchTools(context),
    };
    const messages = modelMessages(
      context.chat,
      context.job,
      resolvedContextWindow(context),
      contextModeOf(effectiveModelParams(context.chat, context.job)),
      context.onCompaction,
    );
    const route = routeTask(context.job.message);
    const stream = (nextMessages: ModelMessage[], remainingSteps: number) => streamText({
      model: provider.languageModel(oauthModelId),
      instructions: providerPrompt(context.job, Object.keys(oauthTools), false, effectiveModelParams(context.chat, context.job)),
      messages: nextMessages,
      tools: oauthTools,
      reasoning: aiReasoningForSelection(providerKey, effectiveModelParams(context.chat, context.job)),
      providerOptions: providerOptionsFor(context),
      stopWhen: stepCountIs(remainingSteps),
      prepareStep: ({ messages }) => ({ messages: stripProviderReasoning(messages) }),
      abortSignal: context.signal,
    });
    const usage = await consumeAiStream(stream(messages, route.initialSteps), context, oauthTools, messages, stream, route.initialSteps);
    const refreshedAuth = await readFile(authFile, "utf8").catch(() => context.connection.secret);
    if (refreshedAuth !== authPayload && context.job.userId) {
      updateProviderConnection(context.connection.id, context.job.userId, {
        secret: refreshedAuth,
        enabled: true,
      });
    }
    return {
      usage: {
        ...usage,
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function createCodexHome(
  secret: string | undefined,
  authType: "account" | "oauth",
  persistentHome?: string,
) {
  if (!secret?.trim()) return undefined;
  let auth: unknown;
  try {
    auth = JSON.parse(secret);
  } catch {
    throw new Error("Codex credentials are not valid JSON.");
  }
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error("Codex credentials are not a valid JSON object.");
  }
  const home = persistentHome || await mkdtemp(path.join(os.tmpdir(), "ai-chat-codex-"));
  await mkdir(home, { recursive: true, mode: 0o700 });
  const authFile = path.join(home, "auth.json");
  const authObject = authType === "oauth"
    ? (() => {
        const record = (auth as Record<string, unknown>)["openai-codex"];
        const oauth = record && typeof record === "object"
          ? record as Record<string, unknown>
          : {};
        const idToken =
          typeof oauth.idToken === "string"
            ? oauth.idToken
            : typeof oauth.id_token === "string"
              ? oauth.id_token
              : undefined;
        if (typeof oauth.access !== "string" || typeof oauth.refresh !== "string" || !idToken) {
          throw new Error("Codex OAuth credentials are incomplete.");
        }
        return {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            access_token: oauth.access,
            refresh_token: oauth.refresh,
            id_token: idToken,
            ...(typeof oauth.accountId === "string" ? { account_id: oauth.accountId } : {}),
          },
          last_refresh: new Date().toISOString(),
        };
      })()
    : auth;
  await writeFile(authFile, `${JSON.stringify(authObject)}\n`, { encoding: "utf8", mode: 0o600 });
  return { home, authFile, temporary: !persistentHome };
}

export function codexTool(
  item: Record<string, unknown>,
  status: ToolPart["status"] = "completed",
): ToolPart | null {
  const type = asString(item.type);
  if (!type || type === "agent_message" || type === "reasoning") return null;
  const mcpName = asString(item.tool) || asString(item.tool_name) || asString(item.name);
  const output = item.aggregated_output ?? item.output;
  const mcpResult = item.result && typeof item.result === "object"
    ? JSON.stringify(item.result)
    : undefined;
  const name =
    type === "command_execution"
      ? "Codex command"
      : type === "file_change"
        ? "Codex file change"
        : type === "mcp_tool_call"
          ? (mcpName || "call_mcp_tool")
          : `Codex ${type.replaceAll("_", " ")}`;
  const kind = classifyToolKind(mcpName || name, item.arguments, item.output);
  return {
    id: asString(item.id) || crypto.randomUUID(),
    name,
    status,
    kind: type === "file_change" ? "edit" : type.includes("command") ? "shell" : kind,
    ...(item.command ? { input: JSON.stringify(item.command) } : {}),
    ...(item.arguments ? { input: JSON.stringify(item.arguments) } : {}),
    ...(output !== undefined ? { result: asString(output) } : {}),
    ...(mcpResult ? { result: mcpResult } : {}),
  };
}

async function persistCodexOAuthHome(context: ProviderContext, home: {
  authFile: string;
}) {
  if (context.connection.authType !== "oauth" || !context.job.userId) return;
  try {
    const official = JSON.parse(await readFile(home.authFile, "utf8")) as {
      tokens?: {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        account_id?: string;
      };
    };
    const tokens = official.tokens;
    if (!tokens?.access_token || !tokens.refresh_token) return;
    const existing = JSON.parse(context.connection.secret || "{}") as Record<string, unknown>;
    const previous = existing["openai-codex"] && typeof existing["openai-codex"] === "object"
      ? existing["openai-codex"] as Record<string, unknown>
      : {};
    updateProviderConnection(context.connection.id, context.job.userId, {
      secret: JSON.stringify({
        ...existing,
        "openai-codex": {
          ...previous,
          type: "oauth",
          access: tokens.access_token,
          refresh: tokens.refresh_token,
          ...(tokens.id_token || previous.idToken ? { idToken: tokens.id_token || previous.idToken } : {}),
          ...(tokens.account_id || previous.accountId
            ? { accountId: tokens.account_id || previous.accountId }
            : {}),
          expires: Date.now() + 3_600_000,
        },
      }),
      enabled: true,
    });
  } catch {
    // Keep the previous encrypted credentials if the CLI did not write a refresh.
  }
}

async function runCodex(context: ProviderContext): Promise<ProviderResult> {
  const { Codex } = await import("@openai/codex-sdk");
  if (
    (context.connection.authType === "account" || context.connection.authType === "oauth") &&
    !context.connection.secret?.trim()
  ) {
    throw new Error("Codex credentials are not configured.");
  }
  if (context.connection.authType === "api_key" && !context.connection.secret?.trim()) {
    throw new Error("Codex API-key authentication requires a key.");
  }
  const persistentHome = context.connection.authType === "oauth" && context.job.userId
    ? path.join(config.dataDir, "provider-sessions", "codex", context.job.userId, context.connection.id)
    : undefined;
  const codexHome = context.connection.authType === "account" || context.connection.authType === "oauth"
    ? await createCodexHome(context.connection.secret, context.connection.authType, persistentHome)
    : undefined;
  const env = inheritedEnv(codexHome ? { CODEX_HOME: codexHome.home } : {});
  const agentCwd = getUserAgentCwd(context.job.userId);
  const mcp = getMcpServers(providerMcpContext(context)).gateway;
  const codex = new Codex({
    ...(context.connection.authType === "api_key" && context.connection.secret
      ? { apiKey: context.connection.secret }
      : {}),
    config: {
      ...(codexHome ? { cli_auth_credentials_store: "file" as const } : {}),
      mcp_servers: {
        metis_ai: stdioGatewayConfig(mcp),
      },
    },
    env,
  });
  const previousId = context.chat.agentId?.startsWith("codex:")
    ? context.chat.agentId.slice("codex:".length)
    : undefined;
  const threadOptions = {
    model: context.modelId,
    ...(codexReasoningEffortForSelection(
      context.modelId,
      effectiveModelParams(context.chat, context.job),
    )
      ? {
          modelReasoningEffort: codexReasoningEffortForSelection(
            context.modelId,
            effectiveModelParams(context.chat, context.job),
          ),
        }
      : {}),
    workingDirectory: agentCwd,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write" as const,
    approvalPolicy: "never" as const,
  };
  const thread = previousId
    ? codex.resumeThread(previousId, threadOptions)
    : codex.startThread(threadOptions);
  try {
    const prompt = [providerPrompt(context.job, ["metis_ai"], true, effectiveModelParams(context.chat, context.job)), providerConversationPrompt(context)]
      .filter(Boolean)
      .join("\n\nUser request:\n");
    const streamed = await thread.runStreamed(
      prompt,
      { signal: context.signal },
    );
    let usage: Usage | undefined;
    for await (const event of streamed.events) {
      context.onStream({
        type: event.type,
        ...("item" in event ? { item: event.item } : {}),
        ...("usage" in event ? { usage: event.usage } : {}),
        ...("message" in event ? { message: event.message } : {}),
        ...("error" in event ? { error: event.error } : {}),
      });
      if (event.type === "turn.completed") {
        usage = {
          inputTokens: event.usage.input_tokens,
          outputTokens: event.usage.output_tokens,
          totalTokens: event.usage.input_tokens + event.usage.output_tokens,
        };
      } else if (event.type === "turn.failed") {
        throw new Error(event.error.message);
      } else if (event.type === "error") {
        throw new Error(event.message);
      } else if (
        event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed"
      ) {
        const item = asRecord(event.item);
        if (asString(item.type) === "agent_message") {
          const text = asString(item.text);
          if (text) context.onText(text);
        } else {
          const tool = codexTool(item, event.type === "item.completed" ? "completed" : "running");
          if (tool) context.onTool(tool);
        }
      }
    }
    return {
      agentId: thread.id ? `codex:${thread.id}` : undefined,
      usage,
    };
  } finally {
    if (codexHome) {
      await persistCodexOAuthHome(context, codexHome);
      if (codexHome.temporary) {
        await rm(codexHome.home, { recursive: true, force: true }).catch(() => undefined);
      } else {
        await rm(codexHome.authFile, { force: true }).catch(() => undefined);
      }
    }
  }
}

function extractClaudeText(message: Record<string, unknown>) {
  const content = message.message;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = asRecord(part);
      return item.type === "text" ? asString(item.text) : "";
    })
    .filter(Boolean)
    .join("");
}

function claudeTool(message: Record<string, unknown>): ToolPart | null {
  const content = message.message;
  if (!Array.isArray(content)) return null;
  const tool = content.map(asRecord).find((item) => item.type === "tool_use");
  if (!tool) return null;
  return {
    id: asString(tool.id) || crypto.randomUUID(),
    name: asString(tool.name) || "Claude tool",
    status: "completed",
    kind: classifyToolKind(asString(tool.name) || "Claude tool"),
    ...(tool.input ? { input: JSON.stringify(tool.input) } : {}),
  };
}

function claudeMcpServers(servers: ReturnType<typeof getMcpServers>) {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if (server.type === "http") {
        return [name, { type: "http" as const, url: server.url, headers: server.headers }];
      }
      return [name, {
        command: server.command,
        args: server.args,
        env: server.env,
        alwaysLoad: true,
      }];
    }),
  );
}

async function runClaude(context: ProviderContext): Promise<ProviderResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abortController = new AbortController();
  const cancellationWatcher = setInterval(() => {
    if (context.signal.aborted) abortController.abort();
  }, 100);
  const previousId = context.chat.agentId?.startsWith("claude:")
    ? context.chat.agentId.slice("claude:".length)
    : undefined;
  const agentCwd = getUserAgentCwd(context.job.userId);
  const options = {
    cwd: agentCwd,
    model: context.modelId,
    // Disable Claude Code builtins so Metis MCP is the sole tool surface.
    tools: [] as string[],
    permissionMode: "acceptEdits" as const,
    includePartialMessages: true,
    strictMcpConfig: true,
    ...(previousId ? { resume: previousId } : {}),
    env: inheritedEnv({
      ...(context.connection.secret ? { ANTHROPIC_API_KEY: context.connection.secret } : {}),
      CLAUDE_AGENT_SDK_CLIENT_APP: "metis-ai",
    }),
    abortController,
    mcpServers: claudeMcpServers(getMcpServers(providerMcpContext(context))),
    systemPrompt: providerPrompt(context.job, ["mcp"], false, effectiveModelParams(context.chat, context.job)),
  };
  let sessionId: string | undefined;
  let receivedText = false;
  let usage: Usage | undefined;
  const conversation = query({
    prompt: providerConversationPrompt(context),
    options,
  });
  try {
    for await (const message of conversation) {
      const record = asRecord(message);
      sessionId ||= asString(record.session_id);
      if (record.type === "stream_event") {
        const event = asRecord(record.event);
        const delta = asRecord(event.delta);
        if (delta.type === "text_delta") {
          const text = asString(delta.text);
          if (text) {
            receivedText = true;
            context.onText(text);
          }
        }
      } else if (record.type === "assistant") {
        if (!receivedText) {
          const text = extractClaudeText(record);
          if (text) context.onText(text);
        }
        const tool = claudeTool(record);
        if (tool) context.onTool(tool);
      } else if (record.type === "result") {
        const result = asString(record.result);
        if (!receivedText && result) context.onText(result);
        const recordUsage = asRecord(record.usage);
        usage = {
          inputTokens: typeof recordUsage.input_tokens === "number" ? recordUsage.input_tokens : undefined,
          outputTokens: typeof recordUsage.output_tokens === "number" ? recordUsage.output_tokens : undefined,
        };
      }
    }
  } finally {
    clearInterval(cancellationWatcher);
    conversation.close();
  }
  return {
    agentId: sessionId ? `claude:${sessionId}` : undefined,
    usage,
  };
}

async function runAntigravity(context: ProviderContext): Promise<ProviderResult> {
  if (!context.job.userId) throw new Error("Antigravity requires a user id.");
  const effortValue = [
    ...(context.job.modelParams || []),
    ...(context.chat.modelParams || []),
  ].find((param) => param.id === "effort")?.value;
  const legacyVariant = context.modelId.match(/^(gemini-\d+\.\d+-flash|gemini-\d+\.\d+-pro)-(low|medium|high)$/);
  const supportsEffort = antigravitySupportsEffort(context.modelId);
  const extraEnv = context.connection.authType === "oauth"
    ? undefined
    : Object.fromEntries(
        Object.entries({
          ...(context.connection.secret ? { GEMINI_API_KEY: context.connection.secret } : {}),
          ...(context.connection.authType === "vertex_adc"
            ? {
                GOOGLE_GENAI_USE_VERTEXAI: "true",
                ...(typeof context.connection.config.project === "string"
                  ? { GOOGLE_CLOUD_PROJECT: context.connection.config.project }
                  : {}),
                ...(typeof context.connection.config.location === "string"
                  ? { GOOGLE_CLOUD_LOCATION: context.connection.config.location }
                  : {}),
              }
            : {}),
        }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
  const job = {
    userId: context.job.userId,
    connectionId: context.connection.id,
    secret: context.connection.secret || "",
    modelId: legacyVariant?.[1] || context.modelId,
    ...(supportsEffort ? { effort: effortValue || legacyVariant?.[2] || "medium" } : {}),
    prompt: [providerPrompt(context.job, ["antigravity", "mcp"], true, effectiveModelParams(context.chat, context.job)), providerConversationPrompt(context)]
      .filter(Boolean)
      .join("\n\nUser request:\n"),
    cwd: getUserAgentCwd(context.job.userId),
    mcp: getMcpServers(providerMcpContext(context)),
    extraEnv,
    signal: context.signal,
    onText: context.onText,
    onStream: context.onStream,
    onTool: context.onTool,
  };
  if (context.connection.authType === "oauth") {
    await runOfficialAntigravityJob(job);
  } else {
    await runAntigravitySdkJob({
      modelId: job.modelId,
      prompt: job.prompt,
      cwd: job.cwd,
      mcp: job.mcp,
      extraEnv,
      apiKey: context.connection.secret || "",
      signal: context.signal,
      onText: context.onText,
      onStream: context.onStream,
      onTool: context.onTool,
    });
  }
  return {};
}


async function runGrok(context: ProviderContext): Promise<ProviderResult> {
  const binary = typeof context.connection.config.binaryPath === "string" && context.connection.config.binaryPath.trim()
    ? context.connection.config.binaryPath.trim()
    : "grok";
  const result = await runAcpStdioAgent({
    command: binary,
    args: ["agent", "stdio"],
    cwd: getUserAgentCwd(context.job.userId),
    prompt: [providerPrompt(context.job, ["mcp"], true, effectiveModelParams(context.chat, context.job)), providerConversationPrompt(context)]
      .filter(Boolean)
      .join("\n\nUser request:\n"),
    mcp: getMcpServers(providerMcpContext(context)),
    signal: context.signal,
    clientName: "metis-ai",
    onText: context.onText,
    onTool: context.onTool,
  });
  return result.sessionId ? { agentId: `grok:${result.sessionId}` } : {};
}

async function runOpenCode(context: ProviderContext): Promise<ProviderResult> {
  const binary = typeof context.connection.config.binaryPath === "string" && context.connection.config.binaryPath.trim()
    ? context.connection.config.binaryPath.trim()
    : "opencode";
  const result = await runAcpStdioAgent({
    command: binary,
    args: ["acp"],
    cwd: getUserAgentCwd(context.job.userId),
    prompt: [providerPrompt(context.job, ["mcp"], true, effectiveModelParams(context.chat, context.job)), providerConversationPrompt(context)]
      .filter(Boolean)
      .join("\n\nUser request:\n"),
    mcp: getMcpServers(providerMcpContext(context)),
    signal: context.signal,
    clientName: "metis-ai",
    onText: context.onText,
    onTool: context.onTool,
  });
  return result.sessionId ? { agentId: `opencode:${result.sessionId}` } : {};
}

async function runProvider(context: ProviderContext): Promise<ProviderResult> {
  const providerKey = context.connection.providerKey || parseModelKey(context.job.modelId).providerKey;
  const execution = providerExecution(providerKey);
  if (execution === "antigravity-cli") return runAntigravity(context);
  if (execution === "codex-sdk") return runCodex(context);
  if (execution === "claude-agent") return runClaude(context);
  if (execution === "grok-cli") return runGrok(context);
  if (execution === "opencode-cli") return runOpenCode(context);
  return runAiSdk(context);
}

export async function runAlternativeProviderJob(job: AgentJob, initialChat: Chat) {
  const runStartedAt = Date.now();
  const rawParsed = parseModelKey(job.modelId || initialChat.modelId || "");
  const normalizedModelId = normalizeLegacyProviderModelId(rawParsed.providerKey, rawParsed.modelId);
  const parsed = { ...rawParsed, modelId: normalizedModelId };
  if (normalizedModelId !== rawParsed.modelId) {
    const canonicalKey = modelKey(rawParsed.providerKey, normalizedModelId, rawParsed.connectionId);
    updateJob(job.id, { modelId: canonicalKey });
    updateChat(job.chatId, { modelId: canonicalKey }, job.userId);
  }
  const definition = getProviderDefinition(parsed.providerKey);
  if (!definition || parsed.providerKey === "cursor") return false;
  if (!job.userId) throw new Error("A user account is required for provider connections.");
  const connection = parsed.connectionId
    ? getProviderConnection(parsed.connectionId, job.userId)
    : findActiveConnection(job.userId, parsed.providerKey);
  if (!connection || !connection.enabled || connection.providerKey !== parsed.providerKey) {
    throw new Error(`No enabled ${definition.name} connection is configured.`);
  }
  if (!definition.authTypes.includes(connection.authType)) {
    throw new Error(`${definition.name} no longer supports ${connection.authType} authentication.`);
  }
  const credential = getProviderConnectionSecret(connection.id, job.userId);
  if (!credential) throw new Error("Provider connection not found.");
  if (
    definition.kind !== "compatible" &&
    definition.kind !== "antigravity-agent" &&
    definition.kind !== "codex-agent" &&
    definition.kind !== "grok-agent" &&
    definition.kind !== "opencode-agent" &&
    !credential.secret
  ) {
    throw new Error(`${definition.name} requires a configured credential.`);
  }

  const assistantMessageId = crypto.randomUUID();
  let chat = getChat(job.chatId, job.userId) || initialChat;
  let text = "";
  const tools: ToolPart[] = [];
 const parts: MessagePart[] = [];
  const controller = new AbortController();
  let modelSwitchTarget: { modelId: string; modelParams?: Array<{ id: string; value: string }> } | null = null;
  const cancellationWatcher = setInterval(() => {
    const currentJob = getJob(job.id);
    const pendingModelId = currentJob?.pendingModelId?.trim();
    if (pendingModelId && pendingModelId !== job.modelId) {
      modelSwitchTarget = { modelId: pendingModelId, modelParams: currentJob?.pendingModelParams };
      controller.abort();
      return;
    }
    if (currentJob?.status === "cancelled") controller.abort();
  }, 250);
  const emit = (event: string, data: unknown) => appendRunEvent(
    job.id,
    job.chatId,
    job.userId,
    event,
    data,
  );
  let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  let checkpointDirty = false;
  const checkpointNow = () => {
    upsertMessage(job.chatId, {
      id: assistantMessageId,
      role: "assistant",
      content: text,
      ...(tools.length ? { tools: persistToolsForMessage(job.chatId, assistantMessageId, tools) } : {}),
 ...(parts.length ? { parts } : {}),
    });
    checkpointDirty = false;
  };
  const checkpoint = (immediate = false) => {
    checkpointDirty = true;
    if (immediate) {
      if (checkpointTimer) clearTimeout(checkpointTimer);
      checkpointTimer = undefined;
      checkpointNow();
      return;
    }
    if (checkpointTimer) return;
    checkpointTimer = setTimeout(() => {
      checkpointTimer = undefined;
      if (checkpointDirty) checkpointNow();
    }, 500);
  };
  const handoffModelSwitch = () => {
    if (!modelSwitchTarget) return false;
    checkpoint(true);
    const target = modelSwitchTarget;
    const switchedAt = new Date().toISOString();
    updateJob(job.id, {
      status: "switching",
      error: undefined,
      agentId: undefined,
      modelId: target.modelId,
      modelParams: target.modelParams,
      pendingModelId: undefined,
      pendingModelParams: undefined,
      modelSwitchRequestedAt: undefined,
      resumePrompt: `The user switched the active model to ${target.modelId}. Continue the in-progress task from the saved chat/tool/browser state. Do not repeat completed work.`,
      resumeRequestedAt: switchedAt,
    });
    updateChat(job.chatId, {
      modelId: target.modelId,
      modelParams: target.modelParams || [],
      agentId: null,
      runStatus: "running",
      runUpdatedAt: switchedAt,
      queueMessage: null,
      badge: null,
    }, job.userId);
    emit("status", { status: "switching_model", modelId: target.modelId });
    return true;
  };

  const onText = (value: string) => {
    if (!value) return;
    text += value;
    checkpoint();
    emit("text", { text: value });
  };
  const onTool = (tool: ToolPart) => {
    tool = canonicalizeToolPart(tool);
    // write_todos is a state surface, not an append-only tool history. Give it
    // one stable id per run so every update replaces the same Tasks card in
    // persistence and in the live SSE UI instead of creating ghost checklists.
    const normalizedTool = tool.kind === "todo"
      ? { ...tool, id: `todo-${job.id}` }
      : tool;
    let existingIndex = tools.findIndex((item) => item.id === normalizedTool.id);
    if (existingIndex < 0 && normalizedTool.status !== "running") {
      existingIndex = tools.findLastIndex((item) =>
        item.status === "running" && item.name === normalizedTool.name,
      );
      if (existingIndex >= 0) {
        normalizedTool.id = tools[existingIndex].id;
      }
    }
    if (existingIndex >= 0) {
      tools[existingIndex] = { ...tools[existingIndex], ...normalizedTool };
    } else {
      tools.push(normalizedTool);
    }
    checkpoint(true);
    emit("tool", {
      callId: normalizedTool.id,
      name: normalizedTool.name,
      status: normalizedTool.status,
      kind: normalizedTool.kind,
      ...(normalizedTool.input ? { input: normalizedTool.input } : {}),
      ...(normalizedTool.result ? { result: normalizedTool.result } : {}),
      ...(normalizedTool.todos?.length ? { todos: normalizedTool.todos } : {}),
      ...(normalizedTool.subagent ? { subagent: normalizedTool.subagent } : {}),
    });
  };
  const onCompaction = (event: CompactionEvent) => {
 const part: MessagePart = { ...event };
 parts.push(part);
 checkpoint(true);
 emit("compaction", event);
 };
 const onThinking = (data: { text?: string; replace?: boolean; done?: boolean; durationMs?: number }) => {
    emit("thinking", data);
    if (data.done !== true) {
      emit("status", { status: "running", message: "Thinking…" });
    }
  };

  appendMessage(job.chatId, { id: assistantMessageId, role: "assistant", content: "" });
  emit("assistantId", { messageId: assistantMessageId });
  emit("status", { status: "running", message: "Starting model…" });
  updateChat(job.chatId, {
    runStatus: "running",
    runUpdatedAt: new Date().toISOString(),
    queueMessage: null,
  }, job.userId);

  try {
    const result = await runProvider({
      job,
      chat,
      connection: credential,
      modelId: parsed.modelId,
      signal: controller.signal,
      onText,
      onTool,
 onCompaction,
      onThinking: (data) => emit("thinking", data),
      onStream: (data) => emit(data.type === "compaction" ? "compaction" : "stream", data),
    });
    if (modelSwitchTarget && handoffModelSwitch()) return true;
    const durableStatus = getJob(job.id)?.status;
    if (durableStatus === "interrupted") {
      checkpoint();
      emit("status", { status: "interrupted", message: "Run was interrupted before the provider finished." });
      return true;
    }
    const cancelled = controller.signal.aborted || durableStatus === "cancelled";
    if (cancelled) {
      updateChat(job.chatId, {
        runStatus: "cancelled",
        runUpdatedAt: new Date().toISOString(),
        queueMessage: null,
      }, job.userId);
      updateJob(job.id, { status: "cancelled" });
      emit("done", { status: "cancelled", provider: definition.key });
      return true;
    }
    if (!text.trim()) text = "The provider completed without returning a textual response.";
    finalizeAlternativeTools(tools);
    if (modeById(job.modeId || chat.sessionState?.modeId).id === "plan" && text.trim()) {
      const current = getChat(job.chatId, job.userId);
      const existingPlan = current?.workspaces?.find((workspace) => workspace.type === "plan");
      if (!existingPlan && current) {
        const timestamp = new Date().toISOString();
        const workspace = {
          id: crypto.randomUUID(),
          type: "plan" as const,
          name: "Plan",
          content: text.trim().slice(0, 100_000),
          createdAt: timestamp,
          updatedAt: timestamp,
          version: 1,
        };
        updateChat(job.chatId, {
          workspaces: [...(current.workspaces || []), workspace].slice(-20),
        }, job.userId);
        text = `${text.trim()}\n\n[Plan: ${workspace.name}](workspace://plan/${workspace.id})`;
        appendRunEvent(job.id, job.chatId, job.userId, "workspace", { workspace });
      }
    }
    recordSignal({
      modelId: parsed.modelId,
      category: telemetryCategory(job.message),
      success: true,
      totalLatencyMs: Math.max(0, Date.now() - runStartedAt),
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      toolCallCount: tools.length,
      toolFailures: tools.some((tool) => tool.status === "error"),
      createdAt: new Date().toISOString(),
    });
    checkpoint();
    const measuredInputTokens = result.usage?.inputTokens;
    const inputTokens = measuredInputTokens ?? estimateProviderInputTokens(chat, job, parsed.modelId);
    chat = updateChat(job.chatId, {
      ...(result.agentId ? { agentId: result.agentId } : {}),
      runStatus: "completed",
      runUpdatedAt: new Date().toISOString(),
      queueMessage: null,
    }, job.userId) || chat;
    upsertMessage(job.chatId, {
      id: assistantMessageId,
      role: "assistant",
      content: text,
      ...(tools.length ? { tools: persistToolsForMessage(job.chatId, assistantMessageId, tools) } : {}),
 ...(parts.length ? { parts } : {}),
      runMetadata: {
        providerId: definition.key,
        modelId: parsed.modelId,
        inputTokens,
        ...(measuredInputTokens === undefined ? { inputTokensEstimated: true } : {}),
        ...(result.usage?.outputTokens !== undefined ? { outputTokens: result.usage.outputTokens } : {}),
        ...(result.usage?.totalTokens !== undefined ? { totalTokens: result.usage.totalTokens } : {}),
        completedAt: new Date().toISOString(),
      },
    });
    updateJob(job.id, {
      status: "completed",
      ...(result.agentId ? { agentId: result.agentId } : {}),
    });
    emit("done", {
      status: "finished",
      provider: definition.key,
      modelId: parsed.modelId,
      ...(result.agentId ? { agentId: result.agentId } : {}),
    });
  } catch (error) {
    if (modelSwitchTarget && handoffModelSwitch()) return true;
    const durableStatus = getJob(job.id)?.status;
    const interrupted = durableStatus === "interrupted";
    const cancelled = controller.signal.aborted || durableStatus === "cancelled";
    const message = cancelled
      ? "Provider run cancelled."
      : interrupted
        ? "Provider run interrupted."
        : error instanceof Error
          ? error.message
          : "Provider run failed.";
    finalizeAlternativeTools(tools);
    recordSignal({
      modelId: parsed.modelId,
      category: telemetryCategory(job.message),
      success: false,
      totalLatencyMs: Math.max(0, Date.now() - runStartedAt),
      toolCallCount: tools.length,
      toolFailures: true,
      createdAt: new Date().toISOString(),
    });
    if (!cancelled && !interrupted) {
      void logError({
        level: "error",
        source: "worker",
        chatId: job.chatId,
        userId: job.userId || undefined,
        message: `Provider run failed (${definition.key}): ${message}`,
        stack: error instanceof Error ? error.stack : undefined,
        context: { jobId: job.id, provider: definition.key, modelId: parsed.modelId },
      });
    }
    if (interrupted) {
      checkpoint();
      emit("status", { status: "interrupted", message });
    } else if (cancelled) {
      updateChat(job.chatId, { runStatus: "cancelled", runUpdatedAt: new Date().toISOString() }, job.userId);
      updateJob(job.id, { status: "cancelled", error: message });
      emit("done", { status: "cancelled", provider: definition.key });
    } else {
      upsertMessage(job.chatId, {
        id: assistantMessageId,
        role: "assistant",
        content: text,
        errorMessage: message,
        ...(tools.length ? { tools: persistToolsForMessage(job.chatId, assistantMessageId, tools) } : {}),
 ...(parts.length ? { parts } : {}),
      });
      updateChat(job.chatId, {
        runStatus: "error",
        runUpdatedAt: new Date().toISOString(),
        queueMessage: null,
        badge: "red",
      }, job.userId);
      updateJob(job.id, { status: "error", error: message });
      emit("error", { message });
    }
  } finally {
    if (checkpointTimer) clearTimeout(checkpointTimer);
    if (checkpointDirty) checkpointNow();
    clearInterval(cancellationWatcher);
  }
  return true;
}
