import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stepCountIs, streamText, type ModelMessage, type ToolSet } from "ai";
import { createOAuthProvider, ensureAntigravityProjectId, type OAuthProviderKey } from "@/lib/providers/oauth";
import { updateProviderConnection } from "@/lib/provider-connections";
import {
  agentToolsFor,
  aiModel,
  aiReasoningForSelection,
  anthropicProviderOptionsForSelection,
  consumeAiStream,
  effectiveModelParams,
  modelMessages,
  providerNativeSearchTools,
  providerOptionsFor,
  providerPrompt,
  resolvedContextWindow,
  stripProviderReasoning,
  type ProviderContext,
} from "./provider-support";
import { routeTask } from "@/lib/agent-efficiency";
import { unsupported, type ProviderAdapterShape, type ProviderResult } from "./contract";
import { contextModeOf } from "@/lib/context-window";

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
  const stream = (nextMessages: ModelMessage[], remainingSteps: number) =>
    streamText({
      model: aiModel(
        context.connection.providerKey,
        context.modelId,
        context.connection,
      ),
      instructions: providerPrompt(
        context.job,
        Object.keys(tools),
        false,
        effectiveModelParams(context.chat, context.job),
      ),
      messages: nextMessages,
      tools,
      reasoning: aiReasoningForSelection(
        context.connection.providerKey,
        effectiveModelParams(context.chat, context.job),
      ),
      providerOptions: providerOptionsFor(context),
      prepareStep: ({ messages }) => ({
        messages: stripProviderReasoning(messages),
      }),
      abortSignal: context.signal,
      stopWhen: stepCountIs(remainingSteps),
    });
  return {
    usage: await consumeAiStream(
      stream(messages, route.initialSteps),
      context,
      tools,
      messages,
      stream,
      route.initialSteps,
    ),
  };
}

async function runOAuthAiSdk(
  context: ProviderContext,
  providerKey: OAuthProviderKey,
): Promise<ProviderResult> {
  if (!context.connection.secret) {
    throw new Error(
      "OAuth connection is not completed yet. Connect the provider first.",
    );
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ai-chat-oauth-run-"));
  const authFile = path.join(tempDir, "oauth.json");
  let authPayload = context.connection.secret;
  if (providerKey === "antigravity") {
    try {
      const parsed = JSON.parse(authPayload) as Record<string, unknown>;
      const token =
        parsed.token && typeof parsed.token === "object"
          ? (parsed.token as Record<string, unknown>)
          : undefined;
      if (
        token &&
        typeof token.access_token === "string" &&
        typeof token.refresh_token === "string"
      ) {
        const expiry =
          typeof token.expiry === "string" ? Date.parse(token.expiry) : NaN;
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
    const stream = (nextMessages: ModelMessage[], remainingSteps: number) =>
      streamText({
        model: provider.languageModel(oauthModelId),
        instructions: providerPrompt(
          context.job,
          Object.keys(oauthTools),
          false,
          effectiveModelParams(context.chat, context.job),
          providerKey,
        ),
        messages: nextMessages,
        tools: oauthTools,
        reasoning: aiReasoningForSelection(
          providerKey,
          effectiveModelParams(context.chat, context.job),
        ),
        providerOptions: providerOptionsFor(context),
        stopWhen: stepCountIs(remainingSteps),
        prepareStep: ({ messages }) => ({
          messages: stripProviderReasoning(messages),
        }),
        abortSignal: context.signal,
      });
    const usage = await consumeAiStream(
      stream(messages, route.initialSteps),
      context,
      oauthTools,
      messages,
      stream,
      route.initialSteps,
    );
    const refreshedAuth = await readFile(authFile, "utf8").catch(
      () => context.connection.secret,
    );
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



export const aiSdkAdapter: ProviderAdapterShape = {
  key: "ai-sdk",
  capabilities: {
    contextOwner: "metis",
    persistentThreads: false,
    interruptibleTurns: true,
    interactiveRequests: false,
    sessionModelSwitch: "unsupported",
    nativeSubagents: false,
    nativeContextTelemetry: false,
  },
  startSession: () => unsupported("startSession", "ai-sdk"),
  sendTurn: () => unsupported("sendTurn", "ai-sdk"),
  interrupt: () => unsupported("interrupt", "ai-sdk"),
  respondToRequest: () => unsupported("respondToRequest", "ai-sdk"),
  respondToUserInput: () => unsupported("respondToUserInput", "ai-sdk"),
  stopSession: async () => {},
  readThread: () => unsupported("readThread", "ai-sdk"),
  rollbackThread: () => unsupported("rollbackThread", "ai-sdk"),
  // eslint-disable-next-line require-yield -- ready-signal only; no turn history to replay while the facade owns the listener
  async *streamEvents(context) {
    // Runtime events are emitted by the adapter while a turn is active. The
    // facade currently owns this process-wide listener, so a cold stream has
    // no buffered turn history to replay.
    context.onStream({ type: "runtime.stream.ready", provider: "ai-sdk" });
  },
  runTurn: runAiSdk,
};
