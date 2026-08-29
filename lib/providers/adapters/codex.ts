import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { CodexOptions } from "@openai/codex-sdk";
import { config } from "@/lib/config";
import { createCodexHome } from "@/lib/providers/codex-home";
import { getMcpServers } from "@/lib/mcp";
import { updateProviderConnection } from "@/lib/provider-connections";
import { getProviderSessionBinding, updateProviderSessionBinding } from "@/lib/providers/session-bindings";
import { classifyToolKind } from "@/lib/tool-call-display";
import type { ToolPart } from "@/lib/store";

import { getUserAgentCwd } from "@/lib/mcp";
import {
  RUNTIME_MODE_TO_CODEX,
  runtimeModeForChat,
} from "@/lib/runtime-mode";
import {
  asRecord,
  asString,
  codexReasoningEffortForSelection,
  effectiveModelParams,
  inheritedEnv,
  nativeRecoveryPrompt,
  providerCurrentTurnPrompt,
  providerMcpContext,
  providerPrompt,
  resolvedContextWindow,
  type ProviderContext,
} from "./provider-support";
import {
  unsupported,
  type ProviderAdapterShape,
  type ProviderResult,
} from "./contract";

export function codexTool(
  item: Record<string, unknown>,
  status: ToolPart["status"] = "completed",
): ToolPart | null {
  const type = asString(item.type);
  // SDK diagnostic/error items are not executable tools. Actual provider
  // failures arrive as turn.failed/error events and are handled by runCodex.
  // Rendering these items as tools produced misleading "Codex error" rows for
  // harmless config diagnostics while the run continued normally.
  if (!type || type === "agent_message" || type === "reasoning" || type === "error") return null;

  if (type === "todo_list") {
    const items = Array.isArray(item.items) ? item.items : [];
    const todos = items.flatMap((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const entry = value as Record<string, unknown>;
      const content = asString(entry.text) || asString(entry.content) || asString(entry.title);
      if (!content.trim()) return [];
      const completed = entry.completed === true;
      const rawStatus = asString(entry.status).trim().toLowerCase();
      const todoStatus = completed || /^(completed|complete|done)$/.test(rawStatus)
        ? "completed"
        : /^(in[_ -]?progress|running|active)$/.test(rawStatus)
          ? "in_progress"
          : "pending";
      return [{
        id: asString(entry.id) || `codex-todo-${index}`,
        content: content.trim(),
        status: todoStatus,
      }];
    });
    return {
      id: asString(item.id) || crypto.randomUUID(),
      name: "Tasks",
      // A todo_list event is a state snapshot, not a long-running tool call.
      // Individual task status carries progress; the card itself should not spin.
      status: "completed",
      kind: "todo",
      ...(todos.length ? { todos } : {}),
    };
  }

  const mcpName =
    asString(item.tool) || asString(item.tool_name) || asString(item.name);
  const output = item.aggregated_output ?? item.output;
  const mcpResult =
    item.result && typeof item.result === "object"
      ? JSON.stringify(item.result)
      : undefined;
  const name =
    type === "command_execution"
      ? "Codex command"
      : type === "file_change"
        ? "Codex file change"
        : type === "mcp_tool_call"
          ? mcpName || "call_mcp_tool"
          : `Codex ${type.replaceAll("_", " ")}`;
  const kind = classifyToolKind(mcpName || name, item.arguments, item.output);
  return {
    id: asString(item.id) || crypto.randomUUID(),
    name,
    status,
    kind:
      type === "file_change"
        ? "edit"
        : type.includes("command")
          ? "shell"
          : kind,
    ...(item.command ? { input: JSON.stringify(item.command) } : {}),
    ...(item.arguments ? { input: JSON.stringify(item.arguments) } : {}),
    ...(output !== undefined ? { result: asString(output) } : {}),
    ...(mcpResult ? { result: mcpResult } : {}),
  };
}

async function persistCodexOAuthHome(
  context: ProviderContext,
  home: {
    authFile: string;
  },
) {
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
    const existing = JSON.parse(context.connection.secret || "{}") as Record<
      string,
      unknown
    >;
    const previous =
      existing["openai-codex"] && typeof existing["openai-codex"] === "object"
        ? (existing["openai-codex"] as Record<string, unknown>)
        : {};
    updateProviderConnection(context.connection.id, context.job.userId, {
      secret: JSON.stringify({
        ...existing,
        "openai-codex": {
          ...previous,
          type: "oauth",
          access: tokens.access_token,
          refresh: tokens.refresh_token,
          ...(tokens.id_token || previous.idToken
            ? { idToken: tokens.id_token || previous.idToken }
            : {}),
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
    (context.connection.authType === "account" ||
      context.connection.authType === "oauth") &&
    !context.connection.secret?.trim()
  ) {
    throw new Error("Codex credentials are not configured.");
  }
  if (
    context.connection.authType === "api_key" &&
    !context.connection.secret?.trim()
  ) {
    throw new Error("Codex API-key authentication requires a key.");
  }
  const persistentHome =
    context.connection.authType === "oauth" && context.job.userId
      ? path.join(
          config.dataDir,
          "provider-sessions",
          "codex",
          context.job.userId,
          context.connection.id,
        )
      : undefined;
  const codexHome =
    context.connection.authType === "account" ||
    context.connection.authType === "oauth"
      ? await createCodexHome(
          context.connection.secret,
          context.connection.authType,
          persistentHome,
        )
      : undefined;
  const agentCwd = getUserAgentCwd(context.job.userId);
  const mcp = getMcpServers(
    providerMcpContext(context, { runtimeApprovalGate: false }),
  ).gateway;
  const bearerToken = mcp.type === "http"
    ? mcp.headers?.Authorization?.replace(/^Bearer\s+/i, "").trim()
    : undefined;
  const env = inheritedEnv({
    ...(codexHome ? { CODEX_HOME: codexHome.home } : {}),
    ...(bearerToken ? { METIS_MCP_SESSION_TOKEN: bearerToken } : {}),
  });
  const codexMcp: Record<string, string | string[] | Record<string, string>> =
    mcp.type === "http"
      ? {
          url: mcp.url,
          ...(bearerToken ? { bearer_token_env_var: "METIS_MCP_SESSION_TOKEN" } : {}),
        }
      : { command: mcp.command, args: mcp.args, env: mcp.env };
  const codexConfig: NonNullable<CodexOptions["config"]> = {
    ...(codexHome ? { cli_auth_credentials_store: "file" } : {}),
    mcp_servers: { metis_ai: codexMcp },
  };
  const codex = new Codex({
    ...(context.connection.authType === "api_key" && context.connection.secret
      ? { apiKey: context.connection.secret }
      : {}),
    config: codexConfig,
    env,
  });
  const sessionBinding = getProviderSessionBinding(
    context.chat,
    "codex-sdk",
    context.connection.id,
  );
  const legacyPreviousId = context.chat.agentId?.startsWith("codex:")
    ? context.chat.agentId.slice("codex:".length)
    : undefined;
  const previousId = sessionBinding?.lastKnownGoodCursor || legacyPreviousId;
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
    ...RUNTIME_MODE_TO_CODEX[runtimeModeForChat(context.chat)],
  };
  const thread = previousId
    ? codex.resumeThread(previousId, threadOptions)
    : codex.startThread(threadOptions);
  try {
    const prompt = [
      providerPrompt(
        context.job,
        ["metis_ai"],
        true,
        effectiveModelParams(context.chat, context.job),
      ),
      previousId
        ? providerCurrentTurnPrompt(context)
        : nativeRecoveryPrompt(context),
    ]
      .filter(Boolean)
      .join("\n\nUser request:\n");
    const streamed = await thread.runStreamed(prompt, {
      signal: context.signal,
    });
    let usage: ProviderResult["usage"] | undefined;
    let emittedAgentMessage = false;
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
          cachedInputTokens: event.usage.cached_input_tokens,
          cacheWriteInputTokens: event.usage.cache_write_input_tokens,
          // Codex SDK 0.147 exposes per-turn usage but not the app-server's
          // context-window maximum. The shared model metadata resolver supplies
          // that exact provider/registry window; do not manufacture one here.
          usedTokens: event.usage.input_tokens,
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
          const text = asString(item.text).trim();
          if (text) {
            // Codex emits complete assistant-message items rather than token
            // deltas. Keep separate progress messages as separate paragraphs so
            // they never glue together as "...Zugänge.Danach..." in the UI.
            context.onText(`${emittedAgentMessage ? "\n\n" : ""}${text}`);
            emittedAgentMessage = true;
          }
        } else {
          const tool = codexTool(
            item,
            event.type === "item.completed" ? "completed" : "running",
          );
          if (tool) context.onTool(tool);
        }
      }
    }
    if (thread.id) {
      updateProviderSessionBinding({
        chatId: context.chat.id,
        ownerId: context.job.userId,
        execution: "codex-sdk",
        connectionId: context.connection.id,
        contextOwner: "native",
        candidateCursor: thread.id,
        promoteCursor: true,
        modelId: context.modelId,
        ...(usage?.inputTokens !== undefined ? { lastContextTokens: usage.inputTokens } : {}),
        ...(usage?.inputTokens !== undefined ? { lastContextWindow: resolvedContextWindow(context) } : {}),
      });
    }
    return {
      agentId: thread.id ? `codex:${thread.id}` : undefined,
      usage,
    };
  } finally {
    if (codexHome) {
      await persistCodexOAuthHome(context, codexHome);
      if (codexHome.temporary) {
        await rm(codexHome.home, { recursive: true, force: true }).catch(
          () => undefined,
        );
      } else {
        await rm(codexHome.authFile, { force: true }).catch(() => undefined);
      }
    }
  }
}



export const codexAdapter: ProviderAdapterShape = {
  key: "codex-sdk",
  capabilities: {
    contextOwner: "native",
    persistentThreads: true,
    interruptibleTurns: true,
    interactiveRequests: false,
    sessionModelSwitch: "restart-resume",
    nativeSubagents: true,
    nativeContextTelemetry: true,
  },
  startSession: () => unsupported("startSession", "codex-sdk"),
  sendTurn: () => unsupported("sendTurn", "codex-sdk"),
  interrupt: () => unsupported("interrupt", "codex-sdk"),
  respondToRequest: () => unsupported("respondToRequest", "codex-sdk"),
  respondToUserInput: () => unsupported("respondToUserInput", "codex-sdk"),
  stopSession: async () => {},
  readThread: () => unsupported("readThread", "codex-sdk"),
  rollbackThread: () => unsupported("rollbackThread", "codex-sdk"),
  // Adapter shape requires an async iterable even though Codex streams inside runTurn.
  // eslint-disable-next-line require-yield
  async *streamEvents(context) {
    context.onStream({ type: "runtime.stream.ready", provider: "codex-sdk" });
  },
  runTurn: runCodex,
};
