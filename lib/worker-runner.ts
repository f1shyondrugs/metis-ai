import { readFileSync } from "node:fs";
import { Agent } from "@cursor/sdk";
import {
  appendMessage,
  createChat,
  getChat,
  getGlobalModelSettings,
  updateChat,
  upsertMessage,
  type ToolPart,
  type WorkspaceItem,
} from "@/lib/db-store";
import { getProject, projectContextBlock } from "@/lib/projects";
import { skillsCatalogPrompt } from "@/lib/skills";
import { autoSkillActivationPrompt } from "@/lib/skill-routing";
import { getUserAgentCwd, getMcpServers } from "@/lib/mcp";
import { resolveAgentPath } from "@/lib/revert";
import { appendRunEvent, enqueueJob, getJob, touchJob, updateJob } from "@/lib/db-jobs";
import { canonicalizeToolPart } from "@/lib/providers/tool-events";
import { logError } from "@/lib/error-logs";
import { isModelAllowed } from "@/lib/model-access";
import { buildAttachmentPrompt } from "@/lib/uploads";
import type { AgentJob } from "@/lib/jobs";
import {
  findActiveConnection,
  getProviderConnectionSecret,
} from "@/lib/provider-connections";
import { parseModelKey } from "@/lib/providers/types";
import { clearProviderSessionBinding, getProviderSessionBinding, updateProviderSessionBinding } from "@/lib/providers/session-bindings";
import { providerModelsForConnection } from "@/lib/providers/discovery";
import { routeModel, type RoutingModel } from "@/lib/model-routing";
import { routeTask } from "@/lib/agent-efficiency";
import type { Chat } from "@/lib/store";
import { compactChatHistoryForPrompt, runAlternativeProviderJob, COMPACTION_MARKER } from "@/lib/providers/runner";
import { contextModeOf, contextWindowForSelection } from "@/lib/context-window";
import { appendAgentTrace } from "@/lib/agent-trace";
import { parseAgentTranscript, stripTranscriptDump } from "@/lib/agent-transcript";
import { snapshotInterruptedJob } from "@/lib/recovery";
import { createSnapshot } from "@/lib/shared-context";
import { allModes, modeById } from "@/lib/modes";
import { featureFlags } from "@/lib/feature-flags";
import type { AgentMode, MessagePart } from "@/lib/store";
import { compress, type CompressionMode } from "@/lib/compression";
import { compactMessagePartsForPersistence, persistToolsForMessage } from "@/lib/tool-persistence";
import { subagentMetadataFromTool } from "@/lib/subagent-tool";
import { METIS_SHARED_AGENT_CONTROL, toolContractPrompt } from "@/lib/agent-control";
import { classifyToolKind, innerToolName, todosFromToolPayload } from "@/lib/tool-call-display";
import { canRecoverCursorSend, cursorSessionFailureKind } from "@/lib/cursor-session-recovery";
import { providerNativeParams, stripRemovedModelParams } from "@/lib/model-params";
import { recordSignal, type TaskCategory } from "@/lib/model-telemetry";
import { classifyTool, resolveMcpToolName, toolDetailFromArgs } from "@/lib/tool-kind";
import { metisAgentIdentity } from "@/lib/agent-identity";
import { normalizeRuntimeMode } from "@/lib/runtime-mode";
import { captureKnowledgeFromUserTurn } from "@/lib/knowledge-lifecycle";

const AGENT_INIT_TIMEOUT_MS = 90_000;
const AGENT_INACTIVITY_TIMEOUT_MS = 5 * 60_000;
const AGENT_WAIT_TIMEOUT_MS = 90_000;

function telemetryCategory(message: string): TaskCategory {
  const kind = routeTask(message).kind;
  if (kind === "edit") return "coding";
  if (kind === "debug") return "debugging";
  if (kind === "research") return "research";
  if (kind === "lookup") return "chat";
  if (kind === "large") return "long-context";
  return "chat";
}

function nativeToolsForMode(mode: AgentMode, options?: { browserEnabled?: boolean }): string[] | undefined {
  // Provider CLIs must use the Metis MCP surface exclusively. Mode/category
  // filtering is enforced by the gateway's MCP_MODE_POLICY.
  void mode;
  void options;
  return ["mcp"];
}

function toolNameFromDelta(update: {
  callId?: string;
  toolCall?: { type?: string; args?: unknown; result?: unknown };
}) {
  const toolCall = update.toolCall || {};
  const args = asRecord(toolCall.args);
  const typeName = typeof toolCall.type === "string" ? toolCall.type : "";
  if (typeName === "mcp") {
    return resolveMcpToolName(
      typeName,
      args,
      (typeof args.toolName === "string" && args.toolName) ||
        (typeof args.providerIdentifier === "string" && args.providerIdentifier) ||
        "mcp",
    );
  }
  return resolveMcpToolName(typeName || "tool", args);
}

type ProvidedAttachment = {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "file";
  storedName: string;
  size: number;
};

function extractProvidedAttachment(value: unknown): ProvidedAttachment | null {
  if (typeof value === "string") {
    try {
      return extractProvidedAttachment(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.attachment) return extractProvidedAttachment(record.attachment);
  if (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.mimeType === "string" &&
    (record.kind === "image" || record.kind === "file") &&
    typeof record.storedName === "string" &&
    typeof record.size === "number"
  ) {
    return {
      id: record.id,
      name: record.name,
      mimeType: record.mimeType,
      kind: record.kind,
      storedName: record.storedName,
      size: record.size,
    };
  }
  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      const attachment = extractProvidedAttachment(item);
      if (attachment) return attachment;
      if (item && typeof item === "object" && "text" in item) {
        const textAttachment = extractProvidedAttachment((item as { text?: unknown }).text);
        if (textAttachment) return textAttachment;
      }
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const block = asRecord(item);
        return asText(block.text ?? block.content ?? block.message);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const object = asRecord(value);
    return asText(object.text ?? object.content ?? object.message);
  }
  return value == null ? "" : String(value);
}

function readFileSnapshot(rawPath: string, agentCwd: string): string | undefined {
  const filePath = resolveAgentPath(rawPath, agentCwd);
  if (!filePath) return undefined;
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function isDeleteTool(name: string) {
  return /(^|[._:/-])(delete|remove|unlink)(?=[._:/-]|$)/i.test(name);
}

function diffStats(before?: string, after?: string) {
  const beforeLines = (before ?? "").split("\n");
  const afterLines = (after ?? "").split("\n");
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) start += 1;
  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  while (beforeEnd > start && afterEnd > start && beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return {
    additions: Math.max(0, afterEnd - start),
    deletions: Math.max(0, beforeEnd - start),
  };
}

function extractEditMetadata(
  name: string,
  args: unknown,
  agentCwd: string,
  previousDiff?: ToolPart["diff"],
  captureAfter = true,
): Pick<ToolPart, "path" | "diff"> {
  if (classifyTool(name) !== "edit") return {};
  const input = asRecord(args);
  const rawPath = [input.path, input.filePath, input.filename]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!rawPath) return {};

  const metadata: Pick<ToolPart, "path" | "diff"> = { path: rawPath };
  const filePath = resolveAgentPath(rawPath, agentCwd);
  if (!filePath) return metadata;
  const before = previousDiff?.before ?? readFileSnapshot(rawPath, agentCwd);
  if (!captureAfter) return { path: rawPath, diff: { before } };
  if (isDeleteTool(name)) {
    return { path: rawPath, diff: { before, after: undefined, ...diffStats(before, undefined) } };
  }

  const edits = Array.isArray(input.edits)
    ? input.edits
        .map(asRecord)
        .filter((edit) => typeof edit.oldText === "string" && typeof edit.newText === "string")
    : [];
  let after: string | undefined;
  try {
    after = readFileSync(filePath, "utf8");
  } catch {
    after = typeof input.content === "string" ? input.content : undefined;
  }
  if (typeof input.content === "string") after = input.content;

  if (edits.length && typeof after === "string") {
    let reconstructedBefore = after;
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      const edit = edits[index];
      const newText = edit.newText as string;
      const oldText = edit.oldText as string;
      const position = reconstructedBefore.indexOf(newText);
      if (position < 0) break;
      reconstructedBefore = `${reconstructedBefore.slice(0, position)}${oldText}${reconstructedBefore.slice(position + newText.length)}`;
    }
    // A tool_call event can arrive after the SDK has already applied the edit.
    // In that case the snapshot captured from disk is the *after* state and
    // produces a misleading +0 -0 diff. Prefer it only when replaying the
    // declared edit actually produces the recorded result.
    const previousBefore = previousDiff?.before;
    const previousReplaysToAfter = (() => {
      if (typeof previousBefore !== "string") return false;
      let candidate = previousBefore;
      for (const edit of edits) {
        const oldText = edit.oldText as string;
        const newText = edit.newText as string;
        const position = candidate.indexOf(oldText);
        if (position < 0) return false;
        candidate = `${candidate.slice(0, position)}${newText}${candidate.slice(position + oldText.length)}`;
      }
      return candidate === after;
    })();
    const originalBefore = previousReplaysToAfter ? previousBefore : reconstructedBefore;
    return { path: rawPath, diff: { before: originalBefore, after, ...diffStats(originalBefore, after) } };
  }
  return { path: rawPath, diff: { before, after, ...diffStats(before, after) } };
}

function extractSubagent(
  name: string,
  args: unknown,
  result: unknown,
): ToolPart["subagent"] | undefined {
  return subagentMetadataFromTool(name, args, result, classifyTool(name));
}

function normalizeToolId(value: string) {
  return value.trim().replace(/\s+/g, "");
}

function toolEventValue(update: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = update[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function normalizedToolDelta(update: Record<string, unknown>) {
  const nested = asRecord(update.toolCall) || asRecord(update.tool_call) || {};
  return {
    callId: toolEventValue(update, "callId", "call_id", "toolCallId", "tool_call_id") ??
      toolEventValue(nested, "callId", "call_id", "toolCallId", "tool_call_id"),
    name: toolEventValue(update, "name", "toolName", "tool_name", "tool") ??
      toolEventValue(nested, "name", "toolName", "tool_name", "tool"),
    args: toolEventValue(update, "args", "input", "arguments", "toolInput", "tool_input") ??
      toolEventValue(nested, "args", "input", "arguments", "toolInput", "tool_input"),
    result: toolEventValue(update, "result", "output", "content", "toolResult", "tool_result") ??
      toolEventValue(nested, "result", "output", "content", "toolResult", "tool_result"),
  };
}

function isFinishedToolStatus(value: string) {
  return ["completed", "success", "succeeded", "done"].includes(value.trim().toLowerCase());
}

function isActiveToolStatus(value: string) {
  return ["running", "in_progress", "pending", "started", "executing", "queued"].includes(value.trim().toLowerCase());
}

function closeRunningTools(tools: ToolPart[], status: string) {
  for (const tool of tools) {
    if (isActiveToolStatus(tool.status)) tool.status = status;
  }
}

function extractWorkspace(value: string) {
  const visit = (candidate: unknown, depth = 0): {
    type?: "plan" | "canvas";
    id?: string;
    workspaceLink?: string;
    title: string;
    content: string;
    version?: number;
    createdAt?: string;
    updatedAt?: string;
  } | null => {
    if (depth > 8 || candidate == null) return null;
    if (typeof candidate === "string") {
      const plain = candidate.trim();
      if (!plain) return null;
      try {
        return visit(JSON.parse(plain), depth + 1);
      } catch {
        return plain.startsWith("{") ? null : { title: "Plan", content: plain };
      }
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const result = visit(item, depth + 1);
        if (result) return result;
      }
      return null;
    }
    if (typeof candidate !== "object") return null;
    const parsed = candidate as Record<string, unknown>;
    const nested = parsed.value && typeof parsed.value === "object"
      ? parsed.value as Record<string, unknown>
      : {};
    const contentCandidate = [parsed.content, parsed.plan, nested.content, nested.plan]
      .find((item): item is string => typeof item === "string");
    if (contentCandidate !== undefined) {
      const type = [parsed.type, nested.type]
        .find((item): item is "plan" | "canvas" => item === "plan" || item === "canvas");
      const title = [parsed.title, parsed.name, nested.title, nested.name]
        .find((item): item is string => typeof item === "string" && item.trim().length > 0);
      const id = [parsed.id, nested.id]
        .find((item): item is string => typeof item === "string" && item.trim().length > 0);
      const workspaceLink = [parsed.workspaceLink, nested.workspaceLink]
        .find((item): item is string => typeof item === "string" && item.trim().length > 0);
      const version = [parsed.version, nested.version]
        .find((item): item is number => typeof item === "number" && Number.isFinite(item));
      const createdAt = [parsed.createdAt, nested.createdAt]
        .find((item): item is string => typeof item === "string" && item.trim().length > 0);
      const updatedAt = [parsed.updatedAt, nested.updatedAt]
        .find((item): item is string => typeof item === "string" && item.trim().length > 0);
      return {
        type,
        id,
        workspaceLink,
        title: title?.trim() || (type === "canvas" ? "Canvas" : "Plan"),
        content: contentCandidate,
        ...(version !== undefined ? { version: Math.max(1, Math.floor(version)) } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      };
    }
    for (const key of ["value", "content", "text", "result"]) {
      const result = visit(parsed[key], depth + 1);
      if (result) return result;
    }
    return null;
  };
  return visit(value);
}

function extractAutomation(value: string) {
  const visit = (candidate: unknown, depth = 0): { id: string; name: string } | null => {
    if (depth > 8 || candidate == null) return null;
    if (typeof candidate === "string") {
      const plain = candidate.trim();
      if (!plain) return null;
      try {
        return visit(JSON.parse(plain), depth + 1);
      } catch {
        const link = plain.match(/automation:\/\/([^/?#\s]+)/i);
        return link ? { id: decodeURIComponent(link[1]), name: "Automation" } : null;
      }
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const result = visit(item, depth + 1);
        if (result) return result;
      }
      return null;
    }
    if (typeof candidate !== "object") return null;
    const parsed = candidate as Record<string, unknown>;
    const nested = parsed.automation && typeof parsed.automation === "object" && !Array.isArray(parsed.automation)
      ? parsed.automation as Record<string, unknown>
      : parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
        ? parsed.value as Record<string, unknown>
        : {};
    const id = [nested.id, parsed.id]
      .find((item): item is string => typeof item === "string" && item.trim().length > 0);
    if (!id) {
      for (const key of ["automation", "value", "content", "text", "result"]) {
        const result = visit(parsed[key], depth + 1);
        if (result) return result;
      }
      return null;
    }
    const name = [nested.name, parsed.name]
      .find((item): item is string => typeof item === "string" && item.trim().length > 0);
    return { id: id.trim(), name: name?.trim() || "Automation" };
  };
  return visit(value);
}

function extractSuggestions(value: string) {
  const match = value.match(/```suggestions\s*\n([\s\S]*?)```/i);
  if (!match) return { text: value, suggestions: [] as string[] };
  const suggestions = match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=>");
      if (separator <= 0) return line;
      const label = line.slice(0, separator).trim();
      const prompt = line.slice(separator + 2).trim();
      return label && prompt ? { label, prompt } : line;
    })
    .slice(0, 5);
  return {
    text: value.replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim(),
    suggestions,
  };
}

function ensureRecommendationSuggestions(value: string) {
  if (/```suggestions\s*\n/i.test(value)) return value;
  if (!/(demo|stub|noch nicht|nicht produktiv|nicht angebunden|nicht konfiguriert|nicht implementiert|mock|placeholder)/i.test(value)) {
    return value;
  }
  return `${value.trim()}\n\n\`\`\`suggestions\nConnect Resend => Configure Resend and implement a manual email preview.\nConnect real research => Replace demo data with real web search, sources, and error handling.\nMigrate database => Replace JSON storage with a persistent database and migration.\n\`\`\``;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function markJobError(job: AgentJob, message: string) {
  updateJob(job.id, { status: "error", error: message });
  updateChat(job.chatId, {
    runStatus: "error",
    runUpdatedAt: new Date().toISOString(),
    queueMessage: null,
    badge: "red",
  }, job.userId);
  appendRunEvent(job.id, job.chatId, job.userId, "error", { message });
  appendAgentTrace(job, "error", { message });
}

/**
 * Resolve the "auto" model key for a job. Gathers candidates from every
 * enabled provider connection (any provider kind), pulls passive telemetry
 * when the model_signals table exists, and delegates the actual choice to the
 * pure `routeModel` function in lib/model-routing.ts.
 */
async function resolveAutoModel(job: AgentJob, chat: Chat): Promise<string | null> {
  if (!job.userId) return null;
  try {
    const { listChatProviderConnections } = await import("@/lib/provider-connections");
    const connections = listChatProviderConnections(job.userId, false);
    const candidates: RoutingModel[] = [];
    for (const connection of connections) {
      if (connection.providerKey === "cursor") continue;
      try {
        for (const model of providerModelsForConnection(connection)) {
          candidates.push({
            key: model.key,
            id: model.id,
            displayName: model.displayName,
            contextWindow: model.contextWindow,
            tags: "tags" in model && Array.isArray(model.tags) ? model.tags : undefined,
          });
        }
      } catch {
        // A broken connection should not break routing for the others.
      }
    }
    if (!candidates.length) return null;

    // Approximate the working context: current prompt + recent history.
    const historyTokens = Math.ceil(
      chat.messages.slice(-20).reduce((total: number, message: { content: string }) => total + message.content.length, 0) / 4,
    );
    const promptTokens = Math.ceil((job.message || "").length / 4);
    const description = [
      job.message || "",
      job.referenceText ? `context: ${job.referenceText.slice(0, 400)}` : "",
    ].filter(Boolean).join("\n");

    let signals;
    try {
      const { getAllModelPerformance } = await import("@/lib/model-telemetry");
      const known = new Set(candidates.map((model) => model.key));
      const summaries = getAllModelPerformance({ sinceDays: 30 })
        .filter((summary) => known.has(summary.modelId));
      if (summaries.length) {
        signals = {
          byModel: Object.fromEntries(summaries.map((summary) => [summary.modelId, {
            compositeScore: summary.compositeScore,
            successRate: summary.successRate,
            avgTimeToFirstTokenMs: summary.avgTimeToFirstTokenMs,
            avgLatencyMs: summary.avgLatencyMs,
            totalRuns: summary.totalRuns,
          }])),
        };
      }
    } catch {
      // model_signals is created lazily; absence is a normal first-run state.
    }

    const routed = routeModel(description, candidates, signals) ||
      routeModel(description + "\n", candidates) ||
      candidates[0].key;
    return isModelAllowed(job.userId, routed) ? routed : candidates.find((model) => isModelAllowed(job.userId, model.key))?.key || null;
  } catch {
    return null;
  }
}

export async function runQueuedJob(job: AgentJob) {
  const runStartedAt = Date.now();
  const chat = getChat(job.chatId, job.userId);
  if (!chat) {
    markJobError(job, "Chat not found or access denied.");
    return;
  }
  // Knowledge capture is infrastructure, not a model behavior: every real user
  // turn is classified once without spending provider tokens. Internal child,
  // automation and resume prompts are not user knowledge.
  if (!job.automationId && !job.parentJobId && !job.subagentFollowUp && !job.resumePrompt && !job.incognito && !chat.incognito) {
    try {
      captureKnowledgeFromUserTurn({
        chatId: chat.id,
        ownerId: job.userId ?? chat.ownerId,
        message: job.message,
        messageId: job.messageId,
      });
    } catch {
      // Knowledge maintenance must never block the user's actual task.
    }
  }
  let requestedModelId = job.modelId || chat.modelId || "";
  // Context-aware auto routing: "auto" resolves to a concrete model based on
  // the task shape (simple → fast, complex/code → high tier, big context →
  // largest window) across ALL enabled provider connections, not just one
  // provider kind. Passive model_signals telemetry nudges the choice when
  // available. Falls back to the first allowed model when routing cannot
  // decide.
  if (requestedModelId === "auto" && job.userId) {
    const routed = await resolveAutoModel(job, chat);
    if (routed) {
      requestedModelId = routed;
      appendAgentTrace(job, "info", { message: `Auto routing selected ${routed}.` });
    } else {
      markJobError(job, "No model is available for automatic routing. Select a model first.");
      return;
    }
  }
  if (!requestedModelId) {
    markJobError(job, "No model is selected for this chat.");
    return;
  }
  if (!isModelAllowed(job.userId, requestedModelId)) {
    markJobError(job, "This model is not available for your account.");
    return;
  }
  const modelReference = parseModelKey(requestedModelId);
  if (modelReference.providerKey !== "cursor") {
    await runAlternativeProviderJob(job, chat);
    return;
  }
  const cursorConnection = job.userId
    ? findActiveConnection(job.userId, "cursor")
    : null;
  const cursorCredential = cursorConnection && job.userId
    ? getProviderConnectionSecret(cursorConnection.id, job.userId)
    : null;
  const apiKey = cursorCredential?.secret;
  if (!cursorConnection || !apiKey) {
    markJobError(job, "No enabled Cursor SDK connection is configured for this user.");
    return;
  }
  const agentCwd = getUserAgentCwd(job.userId);
  const assistantMessageId = crypto.randomUUID();
  appendMessage(job.chatId, { id: assistantMessageId, role: "assistant", content: "" });
  const emit = (event: string, data: unknown) => {
    appendAgentTrace(job, event, data);
    const result = appendRunEvent(job.id, job.chatId, job.userId, event, data);
    const needsAttention = event === "question" || event === "error";
    if (needsAttention) {
      updateChat(job.chatId, { badge: "red" }, job.userId);
    } else if (event === "done") {
      updateChat(job.chatId, { badge: "blue" }, job.userId);
    }
    return result;
  };
  emit("assistantId", { messageId: assistantMessageId });
  updateChat(job.chatId, {
    runStatus: "running",
    runUpdatedAt: new Date().toISOString(),
    queueMessage: null,
  });
  createSnapshot({
    chatId: job.chatId,
    ...(job.userId ? { ownerId: job.userId } : {}),
    checkpoint: "important",
    runStatus: "running",
    resumeMarker: { jobId: job.id, runId: job.runId || job.id, safe: false, reason: "Agent run was active at checkpoint." },
    availability: "available",
  });
  emit("status", { status: "running", message: "Starting agent session…" });
  let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
  let text = "";
  const tools: ToolPart[] = [];
  const parts: MessagePart[] = [];
  const providedAttachments: ProvidedAttachment[] = [];
  const createdWorkspaces: WorkspaceItem[] = [];
  const createdChats: Array<{ id: string; title: string }> = [];
  const createdAutomations: Array<{ id: string; name: string }> = [];
  const globalModelSettings = getGlobalModelSettings(job.userId);
  const compressionSettings = globalModelSettings.compression;
  const compressionEnabled = Boolean(compressionSettings?.enabled) && !job.incognito && !chat.incognito;
  const compressionMode: CompressionMode = compressionSettings?.mode || "stacked";
  const compressContext = (value: string, enabled: boolean) =>
    compressionEnabled && enabled ? compress(value, compressionMode).text : value;
  const flags = featureFlags(globalModelSettings);
  const activeMode = modeById(job.modeId || chat.sessionState?.modeId, globalModelSettings.customModes || []);
  const modeCategories = flags.browser
    ? activeMode.allowedCategories
    : activeMode.allowedCategories.filter((category) => category !== "browser");
  const nativeTools = nativeToolsForMode({ ...activeMode, allowedCategories: modeCategories }, { browserEnabled: flags.browser });
  const runToolContract = toolContractPrompt({
    modeId: activeMode.id,
    provider: "cursor-agent",
    toolNames: nativeTools,
    nativeTools: nativeTools === undefined,
  });
  const availableModes = allModes(globalModelSettings.customModes || [])
    .map((mode) => `${mode.id} (${mode.name})`)
    .join(", ");
  const mcpContext = {
    chatId: job.chatId,
    userId: job.userId,
    jobId: job.id,
    incognito: Boolean(job.incognito || chat.incognito),
    automation: Boolean(job.automationId),
    modeId: activeMode.id,
    // Runtime approvals are phase-one AI-SDK/GLM gateway behavior. Cursor has
    // its own execution path and must not open a second interactive gate.
    runtimeMode: "full-access",
    modePolicy: JSON.stringify({
      allowedCategories: modeCategories,
      toolOverrides: activeMode.toolOverrides || {},
    }),
    workspaceId: job.chatId,
    attemptId: job.runId || job.id,
    policyVersion: `mode:${activeMode.id}:v1`,
    allowedCategories: modeCategories,
    toolOverrides: activeMode.toolOverrides || {},
    compressionEnabled,
    compressionMode,
    compressionToolResults: Boolean(compressionSettings?.compressToolResults ?? true),
  };
  const configuredSubagentModel = job.extendedModelId ||
    (globalModelSettings.subagentModelEnabled ? globalModelSettings.subagentModelId : undefined);
  const configuredSubagentModelParams = configuredSubagentModel
    ? stripRemovedModelParams(globalModelSettings.modelParamsByModel?.[configuredSubagentModel] || []) || []
    : [];
  const customSubagentDefinitions = configuredSubagentModel
    ? Object.fromEntries(
        ["generalPurpose", "explore", "shell", "browser-use", "bugbot", "security-review", "best-of-n-runner"]
          .map((name) => [
            name,
            {
              description: `Delegate work to a ${name} subagent using the configured standard model.`,
              prompt: activeMode.id === "plan"
                ? `Read-only research/planning subagent. Inspect code and gather facts. Do not write files, do not call create_plan, and return a concise finding for the parent planner. Use the configured standard subagent model (${configuredSubagentModel}).`
                : `Use the configured standard subagent model (${configuredSubagentModel}) for this task.`,
              model: {
                id: configuredSubagentModel,
                ...(configuredSubagentModelParams.length
                  ? { params: configuredSubagentModelParams }
                  : {}),
              },
            },
          ]),
      )
    : undefined;
  const subagentModelInstruction =
    configuredSubagentModel
      ? `Subagent model policy: whenever you delegate work to a subagent, use model "${configuredSubagentModel}". Do not override this configured model with another model.`
      : "Subagent model policy: no standard subagent model is configured. Choose the subagent model yourself.";
  const heartbeat = setInterval(() => {
    touchJob(job.id);
    const active = tools.filter((tool) => isActiveToolStatus(tool.status));
    appendAgentTrace(job, "heartbeat", {
      textChars: text.length,
      toolCount: tools.length,
      activeTools: active.map((tool) => ({ id: tool.id, name: tool.name, status: tool.status })),
    });
  }, 30_000);
  appendAgentTrace(job, "start", {
    modelId: job.modelId,
    modeId: activeMode.id,
    cwd: agentCwd,
    resume: Boolean(job.resumePrompt),
    tracePath: `${job.createdAt.slice(0, 10)}/${job.id}.jsonl`,
  });
  let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  let checkpointDirty = false;
  const checkpointNow = () => {
    upsertMessage(job.chatId, {
      id: assistantMessageId,
      role: "assistant",
      content: text,
      ...(tools.length ? { tools: persistToolsForMessage(job.chatId, assistantMessageId, tools) } : {}),
      ...(parts.length ? { parts: compactMessagePartsForPersistence(parts) } : {}),
      ...(providedAttachments.length ? { attachments: [...providedAttachments] } : {}),
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
    // Chat persistence uses synchronous SQLite writes. Keep live text durable
    // without blocking the HTTP/WebSocket event loop on every token.
    checkpointTimer = setTimeout(() => {
      checkpointTimer = undefined;
      if (checkpointDirty) checkpointNow();
    }, 1500);
  };
  const persistWorkspace = (type: WorkspaceItem["type"], content: string, name = type === "plan" ? "Plan" : "Canvas") => {
    const current = getChat(job.chatId, job.userId);
    if (!current) return;
    const timestamp = new Date().toISOString();
    const heading = content.match(/^\s{0,3}#\s+(.+?)\s*$/m)?.[1]?.trim();
    const requestedName = name.trim();
    let resolvedName = (
      (!requestedName || /^(create\s+)?(plan|canvas)$/i.test(requestedName)) && heading
        ? heading
        : requestedName
    ).slice(0, 200) || (type === "plan" ? "Plan" : "Canvas");
    const names = new Set(
      (current.workspaces || [])
        .filter((item) => item.type === type)
        .map((item) => item.name.trim().toLocaleLowerCase()),
    );
    if (names.has(resolvedName.toLocaleLowerCase())) {
      let suffix = 2;
      const baseName = resolvedName;
      while (names.has(`${baseName} (${suffix})`.toLocaleLowerCase())) suffix += 1;
      resolvedName = `${baseName} (${suffix})`.slice(0, 200);
    }
    const workspace: WorkspaceItem = {
      id: crypto.randomUUID(),
      type,
      name: resolvedName,
      content: content.trim().slice(0, 100_000),
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
    };
    updateChat(job.chatId, {
      workspaces: [
        ...(current.workspaces || []).filter((item) => item.id !== workspace.id),
        workspace,
      ].slice(-20),
    }, job.userId);
    if (!createdWorkspaces.some((item) => item.id === workspace.id)) {
      createdWorkspaces.push(workspace);
    }
    return workspace;
  };
  try {
    const modelParams = stripRemovedModelParams(
      job.modelParams?.length ? job.modelParams : chat.modelParams,
    );
    const model = {
      id: requestedModelId,
      ...(modelParams?.length
        ? { params: providerNativeParams(modelParams, { includeContext: true }) }
        : {}),
    };

    const cursorModel = cursorCredential
      ? providerModelsForConnection(cursorCredential).find((candidate) => candidate.id === requestedModelId)
      : undefined;
    const contextWindow = contextWindowForSelection(
      cursorModel || { id: requestedModelId, providerId: "cursor" },
      modelParams,
    );
    const contextMode = contextModeOf(modelParams);

    // Native Cursor owns its conversation. Metis stores a provider-specific
    // last-known-good binding so switching providers does not destroy it.
    const cursorBinding = getProviderSessionBinding(chat, "cursor-agent", cursorConnection.id);
    const legacyCursorAgentId = job.agentId || chat.agentId || undefined;
    const nativeAgentId = cursorBinding?.lastKnownGoodCursor || legacyCursorAgentId;
    let nativeResumed = false;
    let recoveryBootstrapRecap: string | null = null;
    const buildRecoveryBootstrapRecap = () => {
      if (recoveryBootstrapRecap || job.incognito || chat.incognito) return recoveryBootstrapRecap;
      const compacted = compactChatHistoryForPrompt(chat, {
        excludeMessageId: job.messageId,
        contextWindow,
        contextMode,
        maxChars: 120_000,
      });
      if (!compacted.text.trim()) return null;
      const recap = compress(compacted.text, "stacked").text;
      const boundedRecap = recap.length > 120_000
        ? `[Earlier persisted messages truncated to fit the model context]\n${recap.slice(-120_000)}`
        : recap;
      recoveryBootstrapRecap = `Recovery bootstrap context ${COMPACTION_MARKER} (one-time recap from durable history; preserve task state, TODOs, errors, decisions, and changed files — do not repeat):\n${boundedRecap}`;
      return recoveryBootstrapRecap;
    };
    const hasPriorNativeAgentId = Boolean(nativeAgentId);

    // Try to resume native Cursor session first (without Metis transcript replay).
    if (hasPriorNativeAgentId) {
      try {
        agent = await withTimeout(Agent.resume(nativeAgentId!, {
          apiKey,
          model,
          local: { cwd: agentCwd, settingSources: ["project"] },
          ...(nativeTools ? { tools: nativeTools } : {}),
          mcpServers: getMcpServers(mcpContext),
          ...(customSubagentDefinitions ? { agents: customSubagentDefinitions } : {}),
        }), AGENT_INIT_TIMEOUT_MS, "The agent session could not be resumed within 90 seconds.");
        nativeResumed = true;
      } catch (resumeError) {
        const sessionFailure = cursorSessionFailureKind(resumeError);
        if (sessionFailure === "missing") {
          // Stale agent id (server restart, expired session): fall back to a
          // fresh agent with a ONE-TIME recovery bootstrap recap from durable history.
          appendRunEvent(job.id, job.chatId, job.userId, "info", {
            message: "Previous agent session was not found; started a new session with recovery context.",
          });
          updateChat(job.chatId, { agentId: null }, job.userId);
          clearProviderSessionBinding(job.chatId, job.userId, "cursor-agent", cursorConnection.id);
          buildRecoveryBootstrapRecap();

          agent = await withTimeout(Agent.create({
            apiKey,
            model,
            local: { cwd: agentCwd, settingSources: ["project"] },
            ...(nativeTools ? { tools: nativeTools } : {}),
            mcpServers: getMcpServers(mcpContext),
            ...(customSubagentDefinitions ? { agents: customSubagentDefinitions } : {}),
          }), AGENT_INIT_TIMEOUT_MS, "The agent session could not be created within 90 seconds.");
        } else if (sessionFailure === "active_run") {
          // The persisted agent still has a live/locked run (crashed worker,
          // concurrent send). Retry resume once after a short grace period,
          // then start a fresh session instead of failing the job.
          appendRunEvent(job.id, job.chatId, job.userId, "info", {
            message: "Agent session still had an active run; retrying once before starting a new session.",
          });
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          try {
            agent = await withTimeout(Agent.resume(nativeAgentId!, {
              apiKey,
              model,
              local: { cwd: agentCwd, settingSources: ["project"] },
              ...(nativeTools ? { tools: nativeTools } : {}),
              mcpServers: getMcpServers(mcpContext),
              ...(customSubagentDefinitions ? { agents: customSubagentDefinitions } : {}),
            }), AGENT_INIT_TIMEOUT_MS, "The agent session could not be resumed within 90 seconds.");
            nativeResumed = true;
          } catch (retryError) {
            appendRunEvent(job.id, job.chatId, job.userId, "info", {
              message: "Active run did not clear; starting a new agent session.",
            });
            updateChat(job.chatId, { agentId: null }, job.userId);
            clearProviderSessionBinding(job.chatId, job.userId, "cursor-agent", cursorConnection.id);
            buildRecoveryBootstrapRecap();
            agent = await withTimeout(Agent.create({
              apiKey,
              model,
              local: { cwd: agentCwd, settingSources: ["project"] },
              ...(nativeTools ? { tools: nativeTools } : {}),
              mcpServers: getMcpServers(mcpContext),
              ...(customSubagentDefinitions ? { agents: customSubagentDefinitions } : {}),
            }), AGENT_INIT_TIMEOUT_MS, "The agent session could not be created within 90 seconds.");
          }
        } else {
          throw resumeError;
        }
      }
    } else {
      // No prior native session: fresh agent with normal compaction
      let historyCompacted = false;
      const compactedHistory = (job.incognito || chat.incognito)
        ? { text: "", compacted: false }
        : compactChatHistoryForPrompt(chat, {
            excludeMessageId: job.messageId,
            contextWindow,
            contextMode,
            onCompaction: (event) => {
              historyCompacted = historyCompacted || event.status === "completed";
              const part: MessagePart = { ...event };
              const index = parts.findIndex((item) => item.type === "compaction");
              if (index >= 0) parts[index] = part;
              else parts.push(part);
              emit("compaction", event);
              checkpoint(true);
            },
          });
      // NOTE: Do NOT clear agentId on compaction for native sessions.
      // Native Cursor owns its context; compaction is a Metis concern only.
      agent = await withTimeout(Agent.create({
        apiKey,
        model,
        local: { cwd: agentCwd, settingSources: ["project"] },
        ...(nativeTools ? { tools: nativeTools } : {}),
        mcpServers: getMcpServers(mcpContext),
        ...(customSubagentDefinitions ? { agents: customSubagentDefinitions } : {}),
      }), AGENT_INIT_TIMEOUT_MS, "The agent session could not be created within 90 seconds.");

      // Store compacted history for prompt building (fresh session only)
      if (!job.incognito && !chat.incognito && compactedHistory.text) {
        recoveryBootstrapRecap = compressContext(
          compactedHistory.text,
          Boolean(compressionSettings?.compressChatHistory ?? true),
        )
          ? `Recovery bootstrap context ${COMPACTION_MARKER} (one-time durable bootstrap for a fresh native Cursor session; preserve task state and do not repeat it):\n` +
            compressContext(
              compactedHistory.text,
              Boolean(compressionSettings?.compressChatHistory ?? true),
            )
          : null;
      }
    }

    emit("status", { status: "running", message: "Waiting for the model…" });
    updateProviderSessionBinding({
      chatId: job.chatId,
      ownerId: job.userId,
      execution: "cursor-agent",
      connectionId: cursorConnection.id,
      contextOwner: "native",
      candidateCursor: agent.agentId,
      modelId: requestedModelId,
    });
    updateJob(job.id, { agentId: agent.agentId, runId: job.id });
    updateChat(job.chatId, { agentId: agent.agentId }, job.userId);
    const project = !job.incognito && !chat.incognito && chat.projectId ? getProject(chat.projectId, job.userId) : null;

    // Build prompt: native resume gets ONLY current turn + context; fresh/recovery gets bootstrap recap once
    let prompt = [
    metisAgentIdentity(),
    project ? projectContextBlock(project, job.userId) : "",
    skillsCatalogPrompt(getGlobalModelSettings(job.userId)),
    autoSkillActivationPrompt(job.message, getGlobalModelSettings(job.userId), {
      hasVisualReference: Boolean(job.attachments?.some((attachment) => attachment.kind === "image")),
    }),
      `Current agent mode: ${activeMode.name}\n${activeMode.instructions}`,
      "Working style: precise, technically fluent, proactive. Act with your tools instead of describing steps. Reply in the user's language — German in, German out. No filler phrases. On clear orders decide and act yourself; ask back only when genuinely ambiguous or destructive.",
      "Execution efficiency: batch related read-only inspection instead of issuing many tiny calls; reuse the known project/repository cwd instead of rediscovering it; run targeted checks while iterating and the expensive full test/build pass only once after the working tree has stopped changing. Parallelize independent lightweight reads when safe, but do not run competing heavyweight builds. Keep progress narration to short milestone updates rather than one message per tool call.",
      runToolContract,
      "Web/browser routing: use web_search for discovery and web_fetch for fast read-only extraction of ordinary public pages (local Scrapling static scraper first, public remote fallback second). For login/authenticated state, forms, uploads/downloads, purchases/checkouts, important state-changing tasks, long interactive page workflows, or any web_fetch result with requiresBrowser=true, ALWAYS use the persistent Metis in-app browser (browser_navigate, browser_form_state, browser_batch, browser_wait_for, browser_fill_form, browser_snapshot). Inspect current browser state first; navigate only when the URL needs to change and never reload/re-login merely to inspect progress. Do not use shell, curl, detached Playwright, or stealth/challenge-bypass tooling as a substitute. If a site blocks static extraction, use the normal persistent browser if appropriate or report the limitation. Request browser_screenshot only when visual reasoning is genuinely required.",
      `Available mode IDs for request_mode_change: ${availableModes || "agent (Agent), plan (Plan), ask (Ask)"}. Use the exact ID before the parentheses; never invent values such as "Code". For implementation or file changes, request modeId "agent".`,
      "Response recommendation rule: when the result is incomplete, uses demo/stub endpoints, or still lacks real integrations, clearly say what is and is not implemented, then always provide 1–3 concise, concrete next-step recommendations in exactly one ```suggestions fenced block so the UI can render clickable actions. End by asking whether to implement the recommended next step. Do not present demo functionality as production-ready.",
      ...(activeMode.id !== "agent" && !job.automationId
        ? [
            "Mode transition rule: if the user's request requires a tool category this mode does not allow, you MUST call the request_mode_change MCP tool and ask for confirmation. Do not merely tell the user to switch modes manually. After confirmation, continue the original request in this same run using the newly allowed MCP tools (for example write_file); do not wait for a second user message.",
          ]
        : []),
      ...(job.incognito || chat.incognito
        ? ["Incognito mode: do not use or mention personal context, memories, chat metadata, notes, or workspaces. Incognito-only tool restrictions are enforced server-side."]
        : job.automationId
          ? [
              "Automation run: execute autonomously without waiting for the user. All tools allowed by the configured mode remain available, including the MCP gateway and child MCPs, remote tools, subagents, and the persistent Metis in-app browser. Use them normally whenever they help complete the task. Never call ask_user, request_mode_change, wait, subagent_status, or any confirmation/user-approval tool. If information is missing, make a safe reasonable assumption and continue; if the task cannot be completed safely, explain that in the final response.",
              "Automation browser state is durable for this run and seeded from the automation context chat. Prefer the shared Metis browser tools for real web interaction so login/session state and live browser visibility remain consistent. Do not launch a detached browser through shell or Playwright.",
              "Automation persistence: treat the current chat as this run's durable transcript. Keep tool/Todo progress current and checkpoint useful intermediate work; long runs may be resumed after worker or process interruptions without repeating completed actions.",
              job.automationContext ? `Automation-level context from the source chat and prior completed runs. Use it as durable background context, but keep this run's transcript separate:\n${job.automationContext}` : "",
            ]
        : [
                  "Personal context: context_search/context_profile retrieve the smallest relevant slice from the owner's shared context hub. Explicit durable facts/preferences from real user turns are captured automatically by Metis; use context_remember only for durable facts discovered through tools or for an explicit correction. Never dump the context hub or memory list into the prompt.",
          ]),
      ...(job.incognito || chat.incognito ? [] : [
      "When referring to an existing or newly created plan/canvas, include its exact Markdown link using workspace://plan/<id> or workspace://canvas/<id>.",
      "When referring to an existing or newly created note, include its exact Markdown link using note://<id>, for example [Note title](note://note-id). Notes must be clickable links, not only bold text.",
      "Use list_notes or search_notes when you need note IDs before linking them.",
      "To create an automation, call create_automation with name, prompt, and schedule (kind: once | interval | days | monthly). Recurring minute schedules must be at least 60. Use list_automations, update_automation, pause_automation, resume_automation, and delete_automation for existing ones. Do not claim an automation was created without a completed tool call. When referring to an automation, include its exact Markdown link using automation://<id>, for example [Name](automation://id).",
      "When you use browser results, selected references, or other verifiable web sources, cite the exact URL immediately after the sentence it supports using the format [Source: Website title](URL). At the end, put every source used in exactly one fenced block starting with ```sources, with one Markdown link per line. Never invent URLs; if no verifiable source is available, do not create a sources block.",
      "Workspace rule: create or edit a plan/canvas only when the active mode and user request allow it. Never claim a workspace exists until the tool result or persisted workspace confirms it.",
      "Memory lifecycle is automatic for explicit durable user facts. Use list_memories only when a task genuinely needs memory inspection; use add_memory/edit_memory only for durable knowledge learned outside the user-turn capture path or explicit corrections. Never bulk-load memories into context.",
      "To edit an existing workspace, call edit_plan or edit_canvas with its exact id and the changed title/content. Do not create a duplicate when the user asked to edit.",
      "When the chat topic is clear or changes, silently call update_chat_keywords with 3-8 concise, non-sensitive search terms using mode=add. Do not mention this metadata maintenance in the main response. Use search_chats when you need to locate an earlier chat by title, keyword, or message content.",
      job.automationId
        ? "Unattended automation approval rule: request_confirmation is unavailable. Follow the automation prompt and existing permissions; do not stop merely to request interactive approval."
        : "Use delete_memory, delete_plan, and delete_canvas only for explicit user requests. Before destructive or external actions, use request_confirmation and continue only when the user chooses Confirm.",
      "Use list_workspaces before editing or deleting a workspace, and use git_status/git_diff to inspect project changes. Browser helpers include browser_extract_text, browser_fill_form, and browser_download.",
      ]),
      "You can create a follow-up chat by outputting exactly one or more fenced blocks in this format:\n```chat title=\"Short title\"\nMessage to send in the new chat\n```\nThe block creates a new chat for the current user, sends the message there, and starts an agent run. Do not claim a chat was created without outputting this block.",
      "When useful, offer up to five concise follow-up questions at the end using exactly this UI-only format. Use `display text => prompt to insert` when the visible label should differ from the inserted prompt:\n```suggestions\nExplain this in more detail => Explain the database synchronization in more detail, with a concrete example.\nShow me an example\n```\nDo not mention or explain this format outside the block.",
      METIS_SHARED_AGENT_CONTROL,
      subagentModelInstruction,
      `Your private AI workspace is:\n${agentCwd}\nUse this directory as the working directory for project files and commands. Do not use another user's workspace.`,
      ...(job.incognito || chat.incognito
        ? []
        : (() => {
            // Native resume: NO persisted context replay (Cursor SDK owns its context)
            if (nativeResumed) return [];
            // Fresh session or recovery bootstrap: include the one-time recap if available
            if (recoveryBootstrapRecap) return [recoveryBootstrapRecap];
            return [];
          })()),
      job.resumePrompt
        ? `Resume the paused agent run. Do not repeat earlier tool calls or user-facing work. Continue only from the saved pause point using this answer/context:\n${compressContext(job.resumePrompt, Boolean(compressionSettings?.compressToolResults ?? true))}`
        : `User message:\n${job.message || "(see attachments)"}`,
      buildAttachmentPrompt(job.chatId, job.attachments, job.userId),
      !job.incognito && !chat.incognito && job.references?.length
        ? `Selected references:\n${job.references.map((reference) => [
            `- [${reference.kind}] ${reference.label}`,
            reference.detail ? `  Detail: ${reference.detail}` : "",
            reference.path ? `  Path/URL: ${reference.path}` : "",
            reference.content ? `  Context:\n${reference.content}` : "",
          ].filter(Boolean).join("\n")).join("\n")}`
        : "",
      !job.incognito && !chat.incognito && job.referenceText ? `Referenced plan:\n${job.referenceText}` : "",
    ].filter(Boolean).join("\n\n");
    let receivedTextDelta = false;
    let cancellationRequested = false;
    let modelSwitchTarget: { modelId: string; modelParams?: Array<{ id: string; value: string }> } | null = null;
    let activeRun: { cancel: () => Promise<unknown> } | null = null;
    let run: Awaited<ReturnType<typeof agent.send>>;
    let sendTimeout: ReturnType<typeof setTimeout> | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const resetInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        const active = tools.filter((tool) => isActiveToolStatus(tool.status));
        const payload = {
          reason: active.length ? "active_tool" : "stream_gap",
          activeTools: active.map((tool) => ({ id: tool.id, name: tool.name, status: tool.status })),
          textChars: text.length,
        };
        appendAgentTrace(job, "inactivity", payload);
        emit("status", {
          status: "running",
          message: active.length
            ? `Waiting on ${active.map((tool) => tool.name).join(", ")}.`
            : "No new tokens for 5 minutes; continuing instead of aborting.",
        });
        resetInactivityTimer();
      }, AGENT_INACTIVITY_TIMEOUT_MS);
    };
    const markSendProgress = () => {
      if (sendTimeout) {
        clearTimeout(sendTimeout);
        sendTimeout = undefined;
      }
      resetInactivityTimer();
    };
    const ingestThinking = (payload: {
      text?: string;
      replace?: boolean;
      done?: boolean;
      durationMs?: number;
    }) => {
      const delta = payload.text || "";
      const lastPart = parts.at(-1);
      if (delta) {
        if (payload.replace || lastPart?.type !== "thinking" || lastPart.done) {
          parts.push({
            type: "thinking",
            content: delta,
            done: payload.done,
            ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
          });
        } else {
          lastPart.content += delta;
          if (payload.done) lastPart.done = true;
          if (typeof payload.durationMs === "number") lastPart.durationMs = payload.durationMs;
        }
      } else if (lastPart?.type === "thinking") {
        if (payload.done) lastPart.done = true;
        if (typeof payload.durationMs === "number") lastPart.durationMs = payload.durationMs;
      }
      checkpoint();
      emit("thinking", payload);
    };
    const ingestTool = (rawToolEvent: Record<string, unknown>, eventType: string) => {
      const normalized = normalizedToolDelta(rawToolEvent);
      const rawCallId = normalized.callId;
      const toolId = normalizeToolId(typeof rawCallId === "string" ? rawCallId : crypto.randomUUID());
      const existingTool = tools.find((tool) => tool.id === toolId)
        || tools.find((tool) => tool.id === `todo-${job.id}`);
      const toolName =
        (typeof normalized.name === "string" && normalized.name) ||
        existingTool?.name ||
        "tool";
      const toolStatus =
        (typeof rawToolEvent.status === "string" && rawToolEvent.status) ||
        (eventType === "tool_result" || eventType === "tool-call-completed" ? "completed" : "running");
      const toolArgs = normalized.args;
      const toolResult = normalized.result;
      const detail = toolDetailFromArgs(toolArgs) || existingTool?.detail;
      const subagent = extractSubagent(toolName, toolArgs, toolResult);
      let editArgs = toolArgs;
      if (editArgs === undefined && existingTool?.input) {
        try {
          editArgs = JSON.parse(existingTool.input);
        } catch {
          editArgs = undefined;
        }
      }
      const editMetadata =
        toolStatus === "running" || isFinishedToolStatus(toolStatus)
          ? extractEditMetadata(
              toolName,
              editArgs,
              agentCwd,
              existingTool?.diff,
              isFinishedToolStatus(toolStatus),
            )
          : {};
      const resolvedName = resolveMcpToolName(toolName, toolArgs, existingTool?.input);
      const displayName = innerToolName(resolvedName, editArgs, toolResult);
      const inputText = editArgs !== undefined ? JSON.stringify(editArgs) : undefined;
      const resultText = toolResult !== undefined && !subagent ? JSON.stringify(toolResult) : undefined;
      const todos = todosFromToolPayload(inputText, resultText);
      const kind = classifyToolKind(displayName || resolvedName, editArgs, toolResult);
      const stableId = kind === "todo" ? `todo-${job.id}` : toolId;
      const nextTool: ToolPart = canonicalizeToolPart({
        id: stableId,
        name: displayName || resolvedName,
        status: toolStatus,
        kind,
        ...(detail ? { detail } : {}),
        ...(editMetadata.path ? { path: editMetadata.path } : {}),
        ...(editMetadata.diff ? { diff: editMetadata.diff } : {}),
        ...(inputText ? { input: inputText } : {}),
        ...(resultText ? { result: resultText } : {}),
        ...(todos?.length ? { todos } : {}),
        ...(subagent ? { subagent } : {}),
      });
      const existingToolIndex = tools.findIndex((tool) => tool.id === stableId);
      if (existingToolIndex >= 0) {
        tools[existingToolIndex] = { ...tools[existingToolIndex], ...nextTool };
      } else {
        tools.push(nextTool);
      }
      const existingPartIndex = parts.findIndex((part) => part.type === "tool" && part.id === stableId);
      if (existingPartIndex >= 0) {
        const previousPart = parts[existingPartIndex];
        if (previousPart.type === "tool") parts[existingPartIndex] = { ...previousPart, ...nextTool };
      } else {
        parts.push({ type: "tool", ...nextTool });
      }
      checkpoint(true);
      const toolResultText = typeof toolResult === "string"
        ? toolResult
        : toolResult ? JSON.stringify(toolResult) : "";
      const providedAttachment =
        toolName === "provide_file" && isFinishedToolStatus(toolStatus)
          ? extractProvidedAttachment(toolResult)
          : null;
      if (providedAttachment && !providedAttachments.some((item) => item.id === providedAttachment.id)) {
        providedAttachments.push(providedAttachment);
      }
      const parsedWorkspace =
        extractWorkspace(toolResultText) ||
        (toolArgs !== undefined ? extractWorkspace(JSON.stringify(toolArgs)) : null) ||
        (existingTool?.input ? extractWorkspace(existingTool.input) : null);
      if (isFinishedToolStatus(toolStatus) && (nextTool.kind === "plan" || nextTool.kind === "canvas") && parsedWorkspace) {
        const workspaceType: WorkspaceItem["type"] = nextTool.kind === "canvas" ? "canvas" : "plan";
        const workspace: WorkspaceItem | undefined = parsedWorkspace.id
          ? {
              id: parsedWorkspace.id,
              type: workspaceType,
              name: parsedWorkspace.title,
              content: parsedWorkspace.content,
              createdAt: parsedWorkspace.createdAt || new Date().toISOString(),
              updatedAt: parsedWorkspace.updatedAt || new Date().toISOString(),
              version: parsedWorkspace.version || 1,
            }
          : persistWorkspace(workspaceType, parsedWorkspace.content, parsedWorkspace.title);
        if (workspace) {
          if (parsedWorkspace.id && !createdWorkspaces.some((item) => item.id === workspace.id)) {
            createdWorkspaces.push(workspace);
          }
          emit("workspace", { workspace });
          nextTool.result = JSON.stringify({
            ...parsedWorkspace,
            id: workspace.id,
            workspaceLink: `workspace://${workspace.type}/${workspace.id}`,
          });
        }
      }
      const parsedAutomation = extractAutomation(toolResultText)
        || (toolArgs !== undefined ? extractAutomation(JSON.stringify(toolArgs)) : null);
      if (
        isFinishedToolStatus(toolStatus)
        && nextTool.kind === "automation"
        && /create_automation/i.test(resolvedName)
        && parsedAutomation?.id
      ) {
        if (!createdAutomations.some((item) => item.id === parsedAutomation.id)) {
          createdAutomations.push(parsedAutomation);
        }
        try {
          const parsedResult = toolResultText ? JSON.parse(toolResultText) as Record<string, unknown> : {};
          nextTool.result = JSON.stringify({
            ...(parsedResult && typeof parsedResult === "object" && !Array.isArray(parsedResult) ? parsedResult : { automation: parsedAutomation }),
            id: parsedAutomation.id,
            automationLink: `automation://${parsedAutomation.id}`,
          });
        } catch {
          nextTool.result = JSON.stringify({
            automation: parsedAutomation,
            automationLink: `automation://${parsedAutomation.id}`,
          });
        }
        const storedTool = tools.find((tool) => tool.id === stableId);
        if (storedTool) storedTool.result = nextTool.result;
        const storedPart = parts.find((part) => part.type === "tool" && part.id === stableId);
        if (storedPart?.type === "tool") storedPart.result = nextTool.result;
      }
      emit("tool", {
        callId: stableId,
        name: nextTool.name,
        status: toolStatus,
        kind: nextTool.kind,
   ...(nextTool.source ? { source: nextTool.source } : {}),
        ...(nextTool.detail ? { detail: nextTool.detail } : {}),
        ...(nextTool.path ? { path: nextTool.path } : {}),
        ...(nextTool.diff ? { diff: nextTool.diff } : {}),
        ...(nextTool.input ? { input: nextTool.input } : {}),
        ...(nextTool.result ? { result: nextTool.result } : {}),
        ...(nextTool.todos?.length ? { todos: nextTool.todos } : {}),
        ...(nextTool.subagent ? { subagent: nextTool.subagent } : {}),
        ...(providedAttachment ? { attachment: providedAttachment } : {}),
      });
    };
    const handleDelta = (update: {
      type: string;
      text?: string;
      callId?: string;
      thinkingDurationMs?: number;
      status?: string;
      message?: string;
      toolCall?: { type?: string; args?: unknown; result?: unknown };
      [key: string]: unknown;
    }) => {
      if (cancellationRequested) return;
      markSendProgress();
      if (update.type === "text-delta") {
        const delta = String(update.text || "");
        if (!delta) return;
        receivedTextDelta = true;
        const nextText = stripTranscriptDump(text + delta);
        if (nextText === text) return;
        const applied = nextText.startsWith(text) ? nextText.slice(text.length) : "";
        text = nextText;
        const lastPart = parts.at(-1);
        if (!applied && lastPart?.type === "text") lastPart.content = nextText;
        else if (lastPart?.type === "text") lastPart.content += applied;
        else parts.push({ type: "text", content: applied || nextText });
        checkpoint();
        if (applied) emit("text", { text: applied });
        return;
      }
      if (update.type === "thinking-delta") {
        ingestThinking({ text: String(update.text || ""), replace: false, done: false });
        return;
      }
      if (update.type === "thinking-completed") {
        ingestThinking({
          done: true,
          ...(typeof update.thinkingDurationMs === "number" ? { durationMs: update.thinkingDurationMs } : {}),
        });
        return;
      }
      if (
        update.type === "tool-call-started" ||
        update.type === "tool-call-delta" ||
        update.type === "partial-tool-call" ||
        update.type === "tool-call-completed"
      ) {
        const toolCall = normalizedToolDelta(update);
        ingestTool({
          ...update,
          callId: toolCall.callId ?? update.callId,
          name: toolCall.name ?? toolNameFromDelta(update),
          status: update.type === "tool-call-completed" ? "completed" : update.status || "running",
          args: toolCall.args,
          result: toolCall.result,
        }, update.type);
        return;
      }
      if (update.type === "step-started") {
        emit("status", { status: "running", message: update.message || "Working…" });
      }
    };
    const cancellationWatcher = setInterval(() => {
      const currentJob = getJob(job.id);
      const pendingModelId = currentJob?.pendingModelId?.trim();
      if (pendingModelId && pendingModelId !== requestedModelId) {
        modelSwitchTarget = { modelId: pendingModelId, modelParams: currentJob?.pendingModelParams };
        void activeRun?.cancel().catch(() => undefined);
        return;
      }
      if (currentJob?.status === "cancelled") {
        cancellationRequested = true;
        void activeRun?.cancel().catch(() => undefined);
      }
    }, 250);
    const startAgentRun = async () => {
      return await Promise.race([
        agent!.send(prompt, {
          mcpServers: getMcpServers(mcpContext),
          onDelta: ({ update }) => {
            handleDelta(update as {
              type: string;
              text?: string;
              callId?: string;
              thinkingDurationMs?: number;
              status?: string;
              message?: string;
              toolCall?: { type?: string; args?: unknown; result?: unknown };
            });
          },
        }),
        new Promise<never>((_, reject) => {
          sendTimeout = setTimeout(
            () => reject(new Error("The agent did not start responding within 90 seconds.")),
            90_000,
          );
        }),
      ]).finally(() => {
        if (sendTimeout) clearTimeout(sendTimeout);
        sendTimeout = undefined;
      });
    };
    try {
      let recoveredSend = false;
      try {
        run = await startAgentRun();
      } catch (sendError) {
        if (!canRecoverCursorSend({
          error: sendError,
          receivedTextDelta,
          toolCount: tools.length,
          alreadyRetried: recoveredSend,
        })) throw sendError;

        recoveredSend = true;
        const failure = cursorSessionFailureKind(sendError);
        const staleAgentId = agent?.agentId || job.agentId || chat.agentId || undefined;
        appendAgentTrace(job, "session_recovery", {
          failure,
          staleAgentId,
          phase: "send",
        });
        emit("status", {
          status: "running",
          message: failure === "active_run"
            ? "Previous agent session was still busy; continuing in a fresh session."
            : "Previous agent session expired; continuing in a fresh session.",
        });

        // Cursor can report a stale/active session only when send() starts, even
        // though Agent.resume() itself succeeded. Dispose that local SDK handle,
        // clear the persisted stale id, and retry this exact prompt once on a
        // fresh session. Because no text/tool progress is allowed before this
        // recovery, the retry cannot duplicate visible agent work.
        await agent?.[Symbol.asyncDispose]().catch(() => undefined);
        updateChat(job.chatId, { agentId: null }, job.userId);
        clearProviderSessionBinding(job.chatId, job.userId, "cursor-agent", cursorConnection.id);
        nativeResumed = false;
        const recovery = buildRecoveryBootstrapRecap();
        if (recovery && !prompt.includes(COMPACTION_MARKER)) {
          prompt = `${prompt}\n\n${recovery}`;
        }
        agent = await withTimeout(Agent.create({
          apiKey,
          model,
          local: { cwd: agentCwd, settingSources: ["project"] },
          ...(nativeTools ? { tools: nativeTools } : {}),
          mcpServers: getMcpServers(mcpContext),
          ...(customSubagentDefinitions ? { agents: customSubagentDefinitions } : {}),
        }), AGENT_INIT_TIMEOUT_MS, "The agent session could not be recreated within 90 seconds.");
        updateProviderSessionBinding({
          chatId: job.chatId, ownerId: job.userId, execution: "cursor-agent",
          connectionId: cursorConnection.id, contextOwner: "native",
          candidateCursor: agent.agentId, modelId: requestedModelId, bumpRecoveryGeneration: true,
        });
        updateJob(job.id, { agentId: agent.agentId, runId: job.id });
        updateChat(job.chatId, { agentId: agent.agentId }, job.userId);
        run = await startAgentRun();
      }
      activeRun = run;
      resetInactivityTimer();
      for await (const event of run.stream()) {
        resetInactivityTimer();
        const currentJob = getJob(job.id);
        const pendingModelId = currentJob?.pendingModelId?.trim();
        if (pendingModelId && pendingModelId !== requestedModelId) {
          modelSwitchTarget = { modelId: pendingModelId, modelParams: currentJob?.pendingModelParams };
          await run.cancel().catch(() => undefined);
          break;
        }
        if (currentJob?.status === "cancelled") {
          cancellationRequested = true;
          await run.cancel().catch(() => undefined);
          break;
        }
        if (event.type === "status") {
        emit("status", {
          status: String((event as { status?: string }).status || "running"),
          message: (event as { message?: string }).message,
        });
        } else if (event.type === "thinking") {
          const thinkingEvent = event as { text?: string; thinking_duration_ms?: number };
          ingestThinking({
            text: thinkingEvent.text || "",
            replace: false,
            done: typeof thinkingEvent.thinking_duration_ms === "number",
            ...(typeof thinkingEvent.thinking_duration_ms === "number"
              ? { durationMs: thinkingEvent.thinking_duration_ms }
              : {}),
          });
        } else if (["tool_call", "tool_use", "tool_result"].includes(String((event as { type?: unknown }).type))) {
        ingestTool(event as unknown as Record<string, unknown>, String((event as { type?: unknown }).type));
        } else if (event.type === "assistant") {
        if (receivedTextDelta) continue;
        const content = (event as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
        for (const block of content || []) {
          if (block.type === "text" && block.text) {
            receivedTextDelta = true;
            text = stripTranscriptDump(text + block.text);
          }
        }
        checkpoint(true);
        emit("text", { text });
        } else {
          appendAgentTrace(job, "sdk_event", {
            type: String((event as { type?: unknown }).type || "unknown"),
          });
        }
      }
    } finally {
      clearInterval(cancellationWatcher);
      if (inactivityTimer) clearTimeout(inactivityTimer);
    }
    const result = await withTimeout(
      run.wait(),
      AGENT_WAIT_TIMEOUT_MS,
      "The agent did not finish within 90 seconds after its stream ended.",
    );
    if (modelSwitchTarget) {
      closeRunningTools(tools, "cancelled");
      checkpoint(true);
      for (const tool of tools) {
        emit("tool", {
          callId: tool.id,
          name: tool.name,
          status: tool.status,
          kind: tool.kind,
      ...(tool.source ? { source: tool.source } : {}),
          ...(tool.path ? { path: tool.path } : {}),
          ...(tool.diff ? { diff: tool.diff } : {}),
          ...(tool.input ? { input: tool.input } : {}),
          ...(tool.result ? { result: tool.result } : {}),
          ...(tool.todos?.length ? { todos: tool.todos } : {}),
          ...(tool.subagent ? { subagent: tool.subagent } : {}),
        });
      }
      const target = modelSwitchTarget;
      const switchedAt = new Date().toISOString();
      const keepCursorSession = parseModelKey(target.modelId).providerKey === "cursor";
      const nextAgentId = keepCursorSession ? agent.agentId : undefined;
      updateChat(job.chatId, {
        modelId: target.modelId,
        modelParams: target.modelParams || [],
        agentId: nextAgentId || null,
        runStatus: "running",
        runUpdatedAt: switchedAt,
        queueMessage: null,
        badge: null,
      }, job.userId);
      emit("status", { status: "switching_model", modelId: target.modelId });
      updateJob(job.id, {
        status: "switching",
        error: undefined,
        agentId: nextAgentId,
        modelId: target.modelId,
        modelParams: target.modelParams,
        pendingModelId: undefined,
        pendingModelParams: undefined,
        modelSwitchRequestedAt: undefined,
        resumePrompt: `The user switched the active model to ${target.modelId}. Continue the in-progress task from the saved agent/chat/tool/browser state. Do not repeat completed tool calls or user-facing work.`,
        resumeRequestedAt: switchedAt,
      });
      return;
    }

    const wasCancelled =
      cancellationRequested ||
      getJob(job.id)?.status === "cancelled" ||
      result.status === "cancelled";
    const durableStatus = getJob(job.id)?.status;
    if (durableStatus === "interrupted") {
      closeRunningTools(tools, "cancelled");
      checkpoint(true);
      emit("status", { status: "interrupted", message: "Run was interrupted before the provider finished." });
      return;
    }
    if (wasCancelled) {
      closeRunningTools(tools, "cancelled");
      checkpoint();
      for (const tool of tools) {
        emit("tool", {
          callId: tool.id,
          name: tool.name,
          status: tool.status,
          kind: tool.kind,
      ...(tool.source ? { source: tool.source } : {}),
          ...(tool.path ? { path: tool.path } : {}),
          ...(tool.diff ? { diff: tool.diff } : {}),
          ...(tool.input ? { input: tool.input } : {}),
          ...(tool.result ? { result: tool.result } : {}),
          ...(tool.todos?.length ? { todos: tool.todos } : {}),
          ...(tool.subagent ? { subagent: tool.subagent } : {}),
        });
      }
      updateChat(job.chatId, {
        runStatus: "cancelled",
        runUpdatedAt: new Date().toISOString(),
        queueMessage: null,
      }, job.userId);
      emit("done", { status: "cancelled", agentId: agent.agentId });
      updateJob(job.id, { status: "cancelled" });
      return;
    }
    // The Cursor SDK can leave the outer MCP tool event in "running" even
    // after ask_user returned and the agent continued. Finalize that event
    // before persisting the assistant message so the UI reflects the actual
    // completed run.
    closeRunningTools(tools, result.status === "error" ? "error" : "completed");
    for (const tool of tools) {
      emit("tool", {
        callId: tool.id,
        name: tool.name,
        status: tool.status,
        kind: tool.kind,
      ...(tool.source ? { source: tool.source } : {}),
        ...(tool.path ? { path: tool.path } : {}),
        ...(tool.diff ? { diff: tool.diff } : {}),
        ...(tool.input ? { input: tool.input } : {}),
        ...(tool.result ? { result: tool.result } : {}),
        ...(tool.todos?.length ? { todos: tool.todos } : {}),
        ...(tool.subagent ? { subagent: tool.subagent } : {}),
      });
    }
    checkpoint(true);
    const resultError = result.status === "error"
      ? result.error?.message || "Agent run failed."
      : undefined;
    if (!text && result.result && !resultError) text = String(result.result);
    if (!text && !resultError) {
      text =
        result.error?.message ||
        "The agent completed without returning a textual response.";
    }
    if (text) {
      const chatBlocks = [...text.matchAll(/```chat(?:\s+title=(?:"([^"]+)"|'([^']+)'|([^\s]+)))?\s*\n([\s\S]*?)```/gi)];
      for (const block of job.incognito || chat.incognito ? [] : chatBlocks) {
        const message = block[4]?.trim();
        if (!message) continue;
        const title = (block[1] || block[2] || block[3] || message).trim().slice(0, 200);
        const child = createChat(title, undefined, job.userId);
        const messageId = crypto.randomUUID();
        appendMessage(child.id, {
          id: messageId,
          role: "user",
          content: message.slice(0, 100_000),
        });
        enqueueJob({
          chatId: child.id,
          userId: job.userId,
          message: message.slice(0, 100_000),
          messageId,
          agentId: job.agentId,
          modeId: job.modeId,
          modelId: job.modelId,
          extendedModelId: job.extendedModelId,
          modelParams: stripRemovedModelParams(job.modelParams),
        });
        createdChats.push({ id: child.id, title: child.title });
        emit("chat", {
          chatId: child.id,
          title: child.title,
          url: `/?c=${encodeURIComponent(child.id)}`,
        });
      }
      if (chatBlocks.length) {
        text = text.replace(/```chat(?:\s+title=(?:"([^"]+)"|'([^']+)'|([^\s]+)))?\s*\n([\s\S]*?)```/gi, "").trim();
      }
      const fenced = text.match(/```plan(?:\s+name=(?:"([^"]+)"|'([^']+)'|(\S+)))?\s*\n([\s\S]*?)```/i);
      let plan = fenced
        ? persistWorkspace("plan", fenced[4], fenced[1] || fenced[2] || fenced[3] || "Plan")
        : null;
      const canvasFence = text.match(/```canvas(?:\s+name=(?:"([^"]+)"|'([^']+)'|(\S+)))?\s*\n([\s\S]*?)```/i);
      const canvas = canvasFence
        ? persistWorkspace("canvas", canvasFence[4], canvasFence[1] || canvasFence[2] || canvasFence[3] || "Canvas")
        : null;
      if (activeMode.id === "plan" && !resultError && !plan && !createdWorkspaces.some((item) => item.type === "plan")) {
        const existingPlan = getChat(job.chatId, job.userId)?.workspaces?.find((item) => item.type === "plan");
        if (!existingPlan && text.trim()) {
          plan = persistWorkspace("plan", text, "Plan");
          appendAgentTrace(job, "plan_fallback", {
            reason: "No plan workspace tool result was received; persisted the final plan response.",
            workspaceId: plan?.id,
          });
        }
      }
      const links = [...createdWorkspaces, plan, canvas].filter((item, index, items): item is WorkspaceItem =>
        Boolean(item) && items.findIndex((candidate) => candidate?.id === item?.id) === index,
      )
        .map((item) => `[${item.type === "plan" ? "Plan" : "Canvas"}: ${item.name}](workspace://${item.type}/${item.id})`);
      const chatLinks = createdChats.map(
        (chat) => `[Chat: ${chat.title}](/?c=${encodeURIComponent(chat.id)})`,
      );
      const allLinks = [...links, ...chatLinks];
      if (allLinks.length && !/(workspace:\/\/(plan|canvas)\/|\/\?c=)/i.test(text)) {
        text = `${text.trim()}\n\n${allLinks.join(" · ")}`;
      }
      if (createdAutomations.length && !/automation:\/\//i.test(text)) {
        text = `${text.trim()}\n\n${createdAutomations
          .map((item) => `[${item.name}](automation://${item.id})`)
          .join(" · ")}`;
      }
    }
    if (!text && (createdWorkspaces.length || createdChats.length || createdAutomations.length)) {
      const workspaceLinks = createdWorkspaces
        .map((item) => `${item.type === "plan" ? "Plan" : "Canvas"} created: [${item.name}](workspace://${item.type}/${item.id})`)
        .join("\n");
      const chatLinks = createdChats
        .map((chat) => `Chat created: [${chat.title}](/?c=${encodeURIComponent(chat.id)})`)
        .join("\n");
      const automationLinks = createdAutomations
        .map((item) => `Automation created: [${item.name}](automation://${item.id})`)
        .join("\n");
      text = [workspaceLinks, chatLinks, automationLinks].filter(Boolean).join("\n");
    }
    const extractedSuggestions = extractSuggestions(ensureRecommendationSuggestions(text));
    text = extractedSuggestions.text;
    if (!receivedTextDelta && text) {
      const lastPart = parts.at(-1);
      if (lastPart?.type === "text") lastPart.content += text;
      else parts.push({ type: "text", content: text });
    }
    if (extractedSuggestions.suggestions.length) {
      emit("suggestions", { suggestions: extractedSuggestions.suggestions });
    }
    const completedAt = new Date().toISOString();
    const usage = result.usage;
    recordSignal({
      modelId: result.model?.id || job.modelId || chat.modelId || "unknown",
      category: telemetryCategory(job.message),
      success: result.status !== "error",
      totalLatencyMs: Math.max(0, Date.now() - runStartedAt),
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      toolCallCount: tools.length,
      toolFailures: tools.some((tool) => tool.status === "error"),
      createdAt: completedAt,
    });
    upsertMessage(job.chatId, {
      id: assistantMessageId,
      role: "assistant",
      content: text,
      ...(resultError ? { errorMessage: resultError } : {}),
      ...(extractedSuggestions.suggestions.length
        ? { suggestions: extractedSuggestions.suggestions }
        : {}),
      ...(tools.length ? { tools: persistToolsForMessage(job.chatId, assistantMessageId, tools) } : {}),
      ...(parts.length ? { parts: compactMessagePartsForPersistence(parts) } : {}),
      ...(providedAttachments.length ? { attachments: providedAttachments } : {}),
      ...(result.status === "finished"
        ? {
            runMetadata: {
              providerId: "cursor",
              modelId: result.model?.id || job.modelId || chat.modelId,
              connectionId: cursorConnection.id,
              ...(typeof usage?.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
              ...(typeof usage?.inputTokens === "number" ? { inputTokens: usage.inputTokens, contextUsedTokens: usage.inputTokens } : {}),
              ...(contextWindow ? { contextWindow } : {}),
              ...(cursorModel?.contextWindowSource ? { contextWindowSource: cursorModel.contextWindowSource } : contextWindow ? { contextWindowSource: "provider" as const } : {}),
              ...(cursorModel?.maxOutputTokens ? { maxOutputTokens: cursorModel.maxOutputTokens } : {}),
              completedAt,
            },
          }
        : {}),
    });
    if (!receivedTextDelta && text) emit("text", { text });
    if (typeof usage?.inputTokens === "number" || contextWindow) {
      emit("context", {
        usedTokens: usage?.inputTokens,
        maxTokens: contextWindow,
        source: typeof usage?.inputTokens === "number" ? "provider" : "estimate",
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
      });
    }
    updateProviderSessionBinding({
      chatId: job.chatId,
      ownerId: job.userId,
      execution: "cursor-agent",
      connectionId: cursorConnection.id,
      contextOwner: "native",
      candidateCursor: agent.agentId,
      promoteCursor: true,
      modelId: requestedModelId,
      ...(typeof usage?.inputTokens === "number" ? { lastContextTokens: usage.inputTokens } : {}),
      ...(contextWindow ? { lastContextWindow: contextWindow } : {}),
    });
    updateChat(job.chatId, {
      agentId: agent.agentId,
      runStatus: resultError ? "error" : "completed",
      runUpdatedAt: new Date().toISOString(),
      queueMessage: null,
      pendingQuestion: null,
      ...(resultError ? { badge: "red" as const } : {}),
    }, job.userId);
    if (resultError) emit("error", { message: resultError });
    else emit("done", { status: result.status, agentId: agent.agentId });
    updateJob(job.id, {
      status: resultError ? "error" : "completed",
      agentId: agent.agentId,
      ...(resultError ? { error: resultError } : {}),
    });
  if (!job.incognito && !chat.incognito) createSnapshot({
      chatId: job.chatId,
      ...(job.userId ? { ownerId: job.userId } : {}),
      checkpoint: "important",
      runStatus: resultError ? "failed" : "completed",
      resumeMarker: { jobId: job.id, runId: job.runId || job.id, safe: true },
      availability: "available",
  });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent run failed.";
    recordSignal({
      modelId: job.modelId || chat.modelId || "unknown",
      category: telemetryCategory(job.message),
      success: false,
      totalLatencyMs: Math.max(0, Date.now() - runStartedAt),
      toolCallCount: tools.length,
      toolFailures: true,
      createdAt: new Date().toISOString(),
    });
    const finalJob = getJob(job.id);
    if (finalJob?.status !== "cancelled" && finalJob?.status !== "interrupted") {
      void logError({
        level: "error",
        source: "worker",
        chatId: job.chatId,
        userId: job.userId || undefined,
        message: `Agent run failed: ${message}`,
        stack: error instanceof Error ? error.stack : undefined,
        context: { jobId: job.id, runId: job.runId },
      });
      upsertMessage(job.chatId, {
        id: assistantMessageId,
        role: "assistant",
        content: text,
        errorMessage: message,
        ...(tools.length ? { tools: persistToolsForMessage(job.chatId, assistantMessageId, tools) } : {}),
        ...(parts.length ? { parts: compactMessagePartsForPersistence(parts) } : {}),
      });
      updateChat(job.chatId, {
        runStatus: "error",
        runUpdatedAt: new Date().toISOString(),
        queueMessage: null,
        badge: "red",
      }, job.userId);
      emit("error", { message });
      updateJob(job.id, { status: "error", error: message });
      createSnapshot({
        chatId: job.chatId,
        ...(job.userId ? { ownerId: job.userId } : {}),
        checkpoint: "recovery",
        runStatus: "failed",
        resumeMarker: { jobId: job.id, runId: job.runId || job.id, safe: true, reason: message },
        availability: "needs_attention",
      });
    } else if (finalJob?.status === "interrupted") {
      snapshotInterruptedJob(finalJob);
      emit("status", { status: "interrupted", message });
    }
  } finally {
    if (checkpointTimer) clearTimeout(checkpointTimer);
    if (checkpointDirty) checkpointNow();
    clearInterval(heartbeat);
    if (agent) await agent[Symbol.asyncDispose]().catch(() => undefined);
  }
}

export async function runJobById(id: string) {
  const job = getJob(id);
  if (job && job.status === "running") await runQueuedJob(job);
}
