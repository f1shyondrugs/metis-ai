import {
  approvalLimits,
  createApproval,
  getApproval,
  heartbeatApproval,
  resolveApproval,
} from "@/lib/db-approvals";
import { getChat, updateChat } from "@/lib/db-store";
import { getMcpServers, getUserAgentCwd } from "@/lib/mcp";
import { getProviderSessionBinding, updateProviderSessionBinding } from "@/lib/providers/session-bindings";
import { resolveClaudeAgentModelId } from "@/lib/providers/claude-context";
import {
  approvalPatternFor,
  RUNTIME_MODE_TO_CLAUDE_PERMISSION,
  runtimeModeForChat,
  shouldAutoApprove,
} from "@/lib/runtime-mode";
import { classifyToolKind } from "@/lib/tool-call-display";
import type { ToolPart } from "@/lib/store";
import {
  asRecord,
  asString,
  effectiveModelParams,
  inheritedEnv,
  nativeRecoveryPrompt,
  providerCurrentTurnPrompt,
  providerMcpContext,
  providerPrompt,
  type ProviderContext,
} from "./provider-support";
import {
  unsupported,
  type ProviderAdapterShape,
  type ProviderResult,
} from "./contract";

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function claudeModelUsageMetadata(value: unknown) {
  const models = asRecord(value);
  let contextWindow: number | undefined;
  let maxOutputTokens: number | undefined;
  let totalProcessedTokens = 0;
  let costUsd = 0;
  for (const raw of Object.values(models)) {
    const entry = asRecord(raw);
    const input = finiteNumber(entry.inputTokens) || 0;
    const output = finiteNumber(entry.outputTokens) || 0;
    const cacheRead = finiteNumber(entry.cacheReadInputTokens) || 0;
    const cacheCreate = finiteNumber(entry.cacheCreationInputTokens) || 0;
    totalProcessedTokens += input + output + cacheRead + cacheCreate;
    const window = finiteNumber(entry.contextWindow);
    const outputMax = finiteNumber(entry.maxOutputTokens);
    const cost = finiteNumber(entry.costUSD);
    if (window && (!contextWindow || window > contextWindow)) contextWindow = window;
    if (outputMax && (!maxOutputTokens || outputMax > maxOutputTokens)) maxOutputTokens = outputMax;
    if (cost) costUsd += cost;
  }
  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(totalProcessedTokens > 0 ? { totalProcessedTokens } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
  };
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
        return [
          name,
          { type: "http" as const, url: server.url, headers: server.headers },
        ];
      }
      return [
        name,
        {
          command: server.command,
          args: server.args,
          env: server.env,
          alwaysLoad: true,
        },
      ];
    }),
  );
}

type ClaudePermissionUpdate =
  import("@anthropic-ai/claude-agent-sdk").PermissionUpdate;

async function waitForClaudeApproval(
  context: ProviderContext,
  toolName: string,
  input: Record<string, unknown>,
  options: { signal?: AbortSignal; title?: string },
): Promise<"allow" | "allow-session" | "deny"> {
  const command =
    typeof input.command === "string" && input.command.trim()
      ? input.command
      : JSON.stringify(input);
  const { approvalId } = createApproval({
    jobId: context.job.id,
    chatId: context.chat.id,
    ownerId: context.job.userId,
    title: options.title || `Approve ${toolName}`,
    command,
    files:
      typeof input.path === "string"
        ? [{ path: input.path, status: "pending" }]
        : undefined,
  });
  const createdAt = Date.now();
  updateChat(
    context.chat.id,
    {
      runStatus: "waiting_for_user",
      pendingApproval: {
        id: approvalId,
        title: options.title || `Approve ${toolName}`,
        ...(command ? { command } : {}),
        ...(typeof input.path === "string"
          ? { files: [{ path: input.path, status: "pending" }] }
          : {}),
        createdAt: new Date(createdAt).toISOString(),
      },
    },
    context.job.userId,
  );

  let lastHeartbeatAt = 0;
  try {
    for (;;) {
      if (context.signal.aborted || options.signal?.aborted) {
        resolveApproval(approvalId, "deny", context.job.userId);
        return "deny";
      }
      // Resolution and heartbeat are independent: a resolved row no longer
      // accepts heartbeats, so checking the row first is authoritative.
      const approval = getApproval(approvalId, context.job.userId);
      if (approval?.status === "resolved" && approval.decision)
        return approval.decision;
      if (Date.now() - lastHeartbeatAt >= 2_000) {
        heartbeatApproval(approvalId);
        lastHeartbeatAt = Date.now();
      }
      if (Date.now() - createdAt >= approvalLimits().timeoutMs) {
        // The waiting runner owns the timeout. Resolving durably prevents a
        // duplicate UI request from approving an already-expired action.
        resolveApproval(approvalId, "deny", context.job.userId);
        return "deny";
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    const latest = getChat(context.chat.id, context.job.userId);
    if (latest?.pendingApproval?.id === approvalId) {
      updateChat(
        context.chat.id,
        { pendingApproval: null },
        context.job.userId,
      );
    }
  }
}

function claudePermissionResult(
  behavior: "allow" | "deny",
  suggestions?: ClaudePermissionUpdate[],
) {
  if (behavior === "deny")
    return { behavior: "deny" as const, message: "User denied" };
  return {
    behavior: "allow" as const,
    ...(suggestions?.length ? { updatedPermissions: suggestions } : {}),
  };
}

function claudeOAuthEnv(secret?: string): Record<string, string> {
  if (!secret?.trim()) return {};
  try {
    const parsed = JSON.parse(secret) as Record<string, unknown>;
    const raw = parsed.anthropic;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const record = raw as Record<string, unknown>;
    const access = typeof record.access === "string" ? record.access.trim() : "";
    const refresh = typeof record.refresh === "string" ? record.refresh.trim() : "";
    return {
      ...(access ? { CLAUDE_CODE_OAUTH_TOKEN: access } : {}),
      ...(refresh ? { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refresh } : {}),
    };
  } catch {
    return {};
  }
}

async function runClaude(context: ProviderContext): Promise<ProviderResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abortController = new AbortController();
  const cancellationWatcher = setInterval(() => {
    if (context.signal.aborted) abortController.abort();
  }, 100);
  const sessionBinding = getProviderSessionBinding(
    context.chat,
    "claude-agent",
    context.connection.id,
  );
  const legacyPreviousId = context.chat.agentId?.startsWith("claude:")
    ? context.chat.agentId.slice("claude:".length)
    : undefined;
  const previousId = sessionBinding?.lastKnownGoodCursor || legacyPreviousId;
  const agentCwd = getUserAgentCwd(context.job.userId);
  const runtimeMode = runtimeModeForChat(context.chat);
  const claudePermissions = RUNTIME_MODE_TO_CLAUDE_PERMISSION[runtimeMode];
  const modelParams = effectiveModelParams(context.chat, context.job);
  const options = {
    cwd: agentCwd,
    model: resolveClaudeAgentModelId(context.modelId, modelParams),
    // Disable Claude Code builtins so Metis MCP is the sole tool surface.
    tools: [] as string[],
    permissionMode: claudePermissions.permissionMode,
    ...(claudePermissions.permissionMode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    includePartialMessages: true,
    strictMcpConfig: true,
    ...(claudePermissions.canUseToolRequired
      ? {
          canUseTool: async (
            toolName: string,
            input: Record<string, unknown>,
            permissionOptions: {
              signal: AbortSignal;
              suggestions?: unknown;
              title?: string;
            },
          ) => {
            if (
              shouldAutoApprove(context.chat.approvedPatterns, toolName, input)
            ) {
              return claudePermissionResult("allow");
            }
            const decision = await waitForClaudeApproval(
              context,
              toolName,
              input,
              {
                signal: permissionOptions.signal,
                title:
                  typeof permissionOptions.title === "string" &&
                  permissionOptions.title.trim()
                    ? permissionOptions.title
                    : undefined,
              },
            );
            if (decision === "allow-session") {
              const latest = getChat(context.chat.id, context.job.userId);
              updateChat(
                context.chat.id,
                {
                  approvedPatterns: [
                    ...(latest?.approvedPatterns || []),
                    approvalPatternFor(toolName, input),
                  ].slice(0, 100),
                },
                context.job.userId,
              );
            }
            return claudePermissionResult(
              decision === "deny" ? "deny" : "allow",
              Array.isArray(permissionOptions.suggestions)
                ? (permissionOptions.suggestions as ClaudePermissionUpdate[])
                : undefined,
            );
          },
        }
      : {}),
    ...(previousId ? { resume: previousId } : {}),
    env: inheritedEnv({
      ...claudeOAuthEnv(context.connection.secret),
      CLAUDE_AGENT_SDK_CLIENT_APP: "metis-ai",
    }),
    abortController,
    mcpServers: claudeMcpServers(
      getMcpServers(
        providerMcpContext(context, { runtimeApprovalGate: false }),
      ),
    ),
    systemPrompt: providerPrompt(
      context.job,
      ["mcp"],
      false,
      modelParams,
    ),
  };
  let sessionId: string | undefined;
  let receivedText = false;
  let usage: ProviderResult["usage"] | undefined;
  const conversation = query({
    prompt: previousId
      ? providerCurrentTurnPrompt(context)
      : nativeRecoveryPrompt(context),
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
        const modelUsage = claudeModelUsageMetadata(record.modelUsage);
        const inputTokens = finiteNumber(recordUsage.input_tokens);
        const outputTokens = finiteNumber(recordUsage.output_tokens);
        const cachedInputTokens = finiteNumber(recordUsage.cache_read_input_tokens);
        const cacheWriteInputTokens = finiteNumber(recordUsage.cache_creation_input_tokens);
        const estimatedActive = (inputTokens || 0) + (outputTokens || 0) + (cachedInputTokens || 0) + (cacheWriteInputTokens || 0);
        usage = {
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
          ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
          ...(estimatedActive > 0 ? { usedTokens: estimatedActive } : {}),
          ...(modelUsage.contextWindow ? { maxTokens: modelUsage.contextWindow } : {}),
          ...(modelUsage.maxOutputTokens ? { maxOutputTokens: modelUsage.maxOutputTokens } : {}),
          ...(modelUsage.totalProcessedTokens ? { totalProcessedTokens: modelUsage.totalProcessedTokens } : {}),
          ...(modelUsage.costUsd ? { costUsd: modelUsage.costUsd } : finiteNumber(record.total_cost_usd) ? { costUsd: finiteNumber(record.total_cost_usd) } : {}),
        };
      }
    }
    try {
      const contextUsage = await conversation.getContextUsage();
      usage = {
        ...(usage || {}),
        usedTokens: contextUsage.totalTokens,
        maxTokens: contextUsage.maxTokens,
        compactsAutomatically: contextUsage.isAutoCompactEnabled,
        ...(typeof contextUsage.autoCompactThreshold === "number"
          ? { autoCompactThreshold: contextUsage.autoCompactThreshold }
          : {}),
      };
    } catch {
      // Older Claude Code/SDK builds may not expose the control API. Keep the
      // modelUsage/registry fallback instead of inventing a window.
    }
  } finally {
    clearInterval(cancellationWatcher);
    conversation.close();
  }
  if (sessionId) {
    updateProviderSessionBinding({
      chatId: context.chat.id,
      ownerId: context.job.userId,
      execution: "claude-agent",
      connectionId: context.connection.id,
      contextOwner: "native",
      candidateCursor: sessionId,
      promoteCursor: true,
      modelId: context.modelId,
      ...(usage?.usedTokens !== undefined
        ? { lastContextTokens: usage.usedTokens }
        : usage?.inputTokens !== undefined
          ? { lastContextTokens: usage.inputTokens }
          : {}),
      ...(usage?.maxTokens !== undefined ? { lastContextWindow: usage.maxTokens } : {}),
    });
  }
  return {
    agentId: sessionId ? `claude:${sessionId}` : undefined,
    usage,
  };
}

export const claudeAdapter: ProviderAdapterShape = {
  key: "claude-agent",
  capabilities: {
    contextOwner: "native",
    persistentThreads: true,
    interruptibleTurns: true,
    interactiveRequests: true,
    sessionModelSwitch: "in-session",
    nativeSubagents: true,
    nativeContextTelemetry: true,
  },
  startSession: () => unsupported("startSession", "claude-agent"),
  sendTurn: () => unsupported("sendTurn", "claude-agent"),
  interrupt: () => unsupported("interrupt", "claude-agent"),
  respondToRequest: () => unsupported("respondToRequest", "claude-agent"),
  respondToUserInput: () => unsupported("respondToUserInput", "claude-agent"),
  stopSession: async () => {},
  readThread: () => unsupported("readThread", "claude-agent"),
  rollbackThread: () => unsupported("rollbackThread", "claude-agent"),
  // eslint-disable-next-line require-yield -- ready-signal only; no turn history to replay while the facade owns the listener
  async *streamEvents(context) {
    context.onStream({ type: "runtime.stream.ready", provider: "claude-agent" });
  },
  runTurn: runClaude,
};
