import { Cursor } from "@cursor/sdk";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { rm } from "node:fs/promises";
import path from "node:path";
import { config } from "@/lib/config";
import { createCodexHome } from "@/lib/providers/codex-home";
import {
  listProviderModels,
  saveProviderModels,
  type ProviderConnectionWithSecret,
} from "@/lib/provider-connections";
import { getProviderDefinition, getProviderModelDefinition, getVerifiedProviderCapabilities } from "@/lib/providers/registry";
import { contextWindowOf } from "@/lib/context-window";
import { resolveModelContextMetadata } from "@/lib/model-context-metadata";
import {
  modelKey,
  type ProviderModel,
  type ProviderModelDefinition,
} from "@/lib/providers/types";

export function normalizeBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl?.trim()) return undefined;
  const parsed = new URL(baseUrl.trim());
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+(?=$)/, "");
  return parsed.toString().replace(/\/+$/, "");
}

function modelEndpoints(baseUrl: string | undefined) {
  const clean = normalizeBaseUrl(baseUrl);
  if (!clean) return [];
  const candidates = clean.endsWith("/v1")
    ? [`${clean}/models`]
    : [`${clean}/models`, `${clean}/v1/models`];
  return [...new Set(candidates)];
}

function authHeaders(providerKey: string, secret?: string): Record<string, string> {
  if (!secret) return {};
  if (providerKey === "anthropic") {
    return {
      "x-api-key": secret,
      "anthropic-version": "2023-06-01",
    };
  }
  if (providerKey === "google") {
    return { "x-goog-api-key": secret };
  }
  return { Authorization: `Bearer ${secret}` };
}

function authHeaderVariants(providerKey: string, secret?: string) {
  if (!secret?.trim()) return [{}];
  const preferred = authHeaders(providerKey, secret.trim());
  return [
    preferred,
    { Authorization: `Bearer ${secret.trim()}` },
    { "x-api-key": secret.trim() },
    { "api-key": secret.trim() },
  ].filter((headers, index, all) =>
    index === all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(headers)),
  );
}

export type CodexOAuthCredentials = {
  access: string;
  refresh: string;
  idToken: string;
  accountId: string;
  expires: number;
};

export function readCodexOAuthCredentials(
  secret: string,
  options: { allowExpired?: boolean } = {},
): CodexOAuthCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error("Codex OAuth credentials are not valid JSON.");
  }
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const raw = root["openai-codex"];
  const record = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const access = typeof record.access === "string" ? record.access.trim() : "";
  const refresh = typeof record.refresh === "string" ? record.refresh.trim() : "";
  const idToken = typeof record.idToken === "string"
    ? record.idToken.trim()
    : typeof record.id_token === "string"
      ? record.id_token.trim()
      : "";
  const accountId = typeof record.accountId === "string"
    ? record.accountId.trim()
    : typeof record.account_id === "string"
      ? record.account_id.trim()
      : "";
  const rawExpiry = record.expires ?? record.expiresAt;
  const expiryNumber = typeof rawExpiry === "number" ? rawExpiry : Number(rawExpiry);
  const expires = Number.isFinite(expiryNumber) && expiryNumber > 0
    ? (expiryNumber < 1e12 ? expiryNumber * 1_000 : expiryNumber)
    : 0;
  if (!access || !refresh || !idToken || !accountId || !expires) {
    throw new Error(
      "Codex OAuth credentials require access, refresh, idToken, accountId, and expiry.",
    );
  }
  if (!options.allowExpired && expires <= Date.now()) {
    throw new Error("Codex OAuth access credentials have expired.");
  }
  return { access, refresh, idToken, accountId, expires };
}

type DiscoveredModel = {
  id: string;
  displayName: string;
  description?: string;
  contextWindow?: number;
  contextWindowDiscovered?: boolean;
  contextWindowSource?: ProviderModelDefinition["contextWindowSource"];
  maxOutputTokens?: number;
  capabilities?: ProviderModel["capabilities"];
  parameters?: ProviderModelDefinition["parameters"];
  defaultParams?: ProviderModelDefinition["defaultParams"];
  tags?: string[];
};

export const NON_CHAT_TOOL_MODEL = /(\bembed|whisper|tts|dall-e|dalle|sora|moderation|babbage|davinci-002|realtime|transcribe|chatgpt-image|gpt-image|gpt-audio|omni-moderation)/i;

function maxOutputTokensOf(value: unknown, depth = 0): number | undefined {
  if (!value || typeof value !== "object" || depth > 3) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of [
    "maxOutputTokens",
    "max_output_tokens",
    "outputTokenLimit",
    "output_token_limit",
    "max_completion_tokens",
    "max_tokens",
  ]) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  }
  for (const key of ["limits", "metadata", "model_info", "modelInfo", "info", "top_provider", "spec"]) {
    const nested = maxOutputTokensOf(record[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

export function modelSupportsChatTools(id: string, displayName = "") {
  const hay = `${id} ${displayName}`;
  if (NON_CHAT_TOOL_MODEL.test(hay)) return false;
  if (/\binstruct\b/i.test(hay)) return false;
  return true;
}

export function parseDiscoveredModel(value: unknown): DiscoveredModel | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string"
    ? item.id
    : typeof item.slug === "string"
      ? item.slug
      : typeof item.model === "string"
        ? item.model
    : typeof item.name === "string"
      ? item.name.replace(/^models\//, "")
      : "";
  if (!id) return null;
  const displayName =
    typeof item.display_name === "string"
      ? item.display_name
      : typeof item.displayName === "string"
        ? item.displayName
        : id;
  const contextWindow = contextWindowOf(item);
  const maxOutputTokens = maxOutputTokensOf(item);
  const capabilities = item.capabilities && typeof item.capabilities === "object"
    ? item.capabilities as ProviderModel["capabilities"]
    : undefined;
  const parameters = Array.isArray(item.parameters)
    ? item.parameters as ProviderModelDefinition["parameters"]
    : undefined;
  const defaultParams = Array.isArray(item.defaultParams)
    ? item.defaultParams as ProviderModelDefinition["defaultParams"]
    : undefined;
  return {
    id,
    displayName,
    ...(typeof item.description === "string" ? { description: item.description } : {}),
    ...(contextWindow ? { contextWindow, contextWindowDiscovered: true, contextWindowSource: "provider" as const } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(parameters ? { parameters } : {}),
    ...(defaultParams ? { defaultParams } : {}),
    ...(Array.isArray(item.tags) ? { tags: item.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 32) } : {}),
  };
}

export function mergeDiscoveredContextWindow(options: {
  discovered?: number;
  stored?: number;
  catalog?: number;
}): number | undefined {
  const valid = (value: unknown) =>
 typeof value === "number" && Number.isFinite(value) && value >= 1_024
 ? Math.round(value)
 : undefined;
 return valid(options.discovered) ?? valid(options.stored) ?? valid(options.catalog);
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: controller.signal,
    });
    const body = await response.text();
    let parsed: unknown = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      const detail = parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error?: unknown }).error)
        : `HTTP ${response.status}`;
      const error = new Error(`${detail} (HTTP ${response.status})`.slice(0, 300)) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDiscoveryJson(
  urls: string[],
  providerKey: string,
  secret?: string,
) {
  let lastError: (Error & { status?: number }) | undefined;
  for (const url of urls) {
    for (const headers of authHeaderVariants(providerKey, secret)) {
      try {
        return await fetchJson(url, headers);
      } catch (error) {
        lastError = error instanceof Error ? error as Error & { status?: number } : new Error(String(error));
        if (lastError.status !== 401 && lastError.status !== 403) break;
      }
    }
  }
  throw lastError || new Error("Model discovery failed.");
}


type CodexAppServerModel = {
  model?: string;
  id?: string;
  displayName?: string;
  description?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string; description?: string }>;
  defaultReasoningEffort?: string;
  hidden?: boolean;
};

async function discoverCodexModelsViaAppServer(connection: ProviderConnectionWithSecret): Promise<DiscoveredModel[]> {
  if (connection.authType !== "oauth" && connection.authType !== "account") {
    throw new Error("Codex app-server discovery requires account or OAuth authentication.");
  }
  const codexHome = await createCodexHome(connection.secret, connection.authType);
  if (!codexHome) throw new Error("Codex credentials are unavailable.");
  const executable = path.join(config.root, "node_modules", ".bin", "codex");
  const child = spawn(executable, ["app-server", "--stdio"], {
    cwd: config.root,
    env: { ...process.env, CODEX_HOME: codexHome.home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || "Codex app-server request failed."));
      else request.resolve(message.result);
    } catch {
      // Ignore non-protocol output. Codex notifications do not have request ids.
    }
  });
  const request = <T>(method: string, params: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex app-server ${method} timed out.`));
    }, 10_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value as T); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await request("initialize", {
      clientInfo: { name: "metis-ai", title: "Metis AI", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const models: CodexAppServerModel[] = [];
    let cursor: string | null | undefined;
    do {
      const result = await request<{ data?: CodexAppServerModel[]; nextCursor?: string | null }>(
        "model/list",
        cursor ? { cursor } : {},
      );
      models.push(...(result.data || []));
      cursor = result.nextCursor;
    } while (cursor);
    const visible = models.filter((model) => !model.hidden && (model.model || model.id));
    if (!visible.length) throw new Error("Codex app-server returned no models for this account.");
    return visible.map((model) => {
      const id = model.model || model.id!;
      const reasoningValues = (model.supportedReasoningEfforts || [])
        .map((entry) => entry.reasoningEffort?.trim())
        .filter((value): value is string => Boolean(value))
        .map((value) => ({ value }));
      const metadata = resolveModelContextMetadata({
        connection,
        modelId: id,
        displayName: model.displayName || id,
        allowInference: false,
      });
      return {
        id,
        displayName: model.displayName || id,
        description: model.description,
        ...(metadata.contextWindow ? { contextWindow: metadata.contextWindow, contextWindowSource: metadata.source } : {}),
        ...(metadata.maxOutputTokens ? { maxOutputTokens: metadata.maxOutputTokens } : {}),
        ...(reasoningValues.length
          ? { parameters: [{ id: "effort", displayName: "Reasoning", values: reasoningValues }] }
          : {}),
        ...(model.defaultReasoningEffort && reasoningValues.some((entry) => entry.value === model.defaultReasoningEffort)
          ? { defaultParams: [{ id: "effort", value: model.defaultReasoningEffort }] }
          : {}),
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`);
  } finally {
    lines.close();
    child.kill("SIGTERM");
    if (codexHome.temporary) await rm(codexHome.home, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function discoverProviderModels(connection: ProviderConnectionWithSecret) {
  const provider = getProviderDefinition(connection.providerKey);
  if (!provider) throw new Error(`Unknown provider: ${connection.providerKey}`);
  if (connection.providerKey === "codex" && (connection.authType === "oauth" || connection.authType === "account")) {
    try {
      return await discoverCodexModelsViaAppServer(connection);
    } catch (appServerError) {
      // Keep the existing account endpoint as a compatibility fallback for
      // installations where the local Codex app-server cannot start.
      if (connection.authType !== "oauth") throw appServerError;
      const credentials = readCodexOAuthCredentials(connection.secret || "");
      const response = await fetch(
        "https://chatgpt.com/backend-api/codex/models?client_version=0.147.0",
        {
          headers: { Authorization: `Bearer ${credentials.access}`, "ChatGPT-Account-Id": credentials.accountId, Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw appServerError;
      const body = await response.json() as { models?: unknown[] } | unknown[];
      const values = Array.isArray(body) ? body : Array.isArray(body.models) ? body.models : [];
      const discovered = values.map(parseDiscoveredModel).filter(Boolean) as DiscoveredModel[];
      if (!discovered.length) throw appServerError;
      return discovered.map((model) => {
        const catalog = provider.models.find((candidate) => candidate.id === model.id);
        const metadata = resolveModelContextMetadata({
          connection,
          modelId: model.id,
          displayName: model.displayName,
          providerContextWindow: model.contextWindowDiscovered ? model.contextWindow : undefined,
          catalogContextWindow: catalog?.contextWindow,
          allowInference: false,
        });
        return {
          ...catalog,
          ...model,
          ...(metadata.contextWindow ? { contextWindow: metadata.contextWindow, contextWindowSource: metadata.source } : {}),
          ...(metadata.maxOutputTokens ? { maxOutputTokens: metadata.maxOutputTokens } : {}),
        };
      });
    }
  }
  if (connection.providerKey === "google" && connection.authType === "vertex_adc") {
    return provider.models;
  }
  if (!provider.capabilities.modelDiscovery || !connection.baseUrl) {
    return provider.models;
  }
  const urls = modelEndpoints(connection.baseUrl);
  if (!urls.length) return provider.models;
  const body = await fetchDiscoveryJson(urls, connection.providerKey, connection.secret);
  const values = Array.isArray(body)
    ? body
    : (() => {
        if (!body || typeof body !== "object") return [];
        const object = body as Record<string, unknown>;
        if (Array.isArray(object.data)) return object.data;
        if (Array.isArray(object.models)) return object.models;
        if (Array.isArray(object.results)) return object.results;
        return object.models && typeof object.models === "object"
          ? Object.values(object.models)
          : [];
      })();
  const discovered = values.map(parseDiscoveredModel).filter(Boolean) as DiscoveredModel[];
  const merged = new Map(provider.models.map((model) => [model.id, { ...model } as DiscoveredModel]));
  for (const model of discovered) {
    const previous = merged.get(model.id);
    const metadata = resolveModelContextMetadata({
      connection,
      modelId: model.id,
      displayName: model.displayName,
      providerContextWindow: model.contextWindowDiscovered ? model.contextWindow : undefined,
      catalogContextWindow: previous?.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      allowInference: false,
    });
    merged.set(model.id, {
      ...previous,
      ...model,
      ...(metadata.contextWindow ? { contextWindow: metadata.contextWindow, contextWindowSource: metadata.source } : {}),
      ...(model.maxOutputTokens || metadata.maxOutputTokens
        ? { maxOutputTokens: model.maxOutputTokens || metadata.maxOutputTokens }
        : {}),
      contextWindowDiscovered: Boolean(model.contextWindowDiscovered),
    });
  }
  const chatModels = [...merged.values()].filter((model) => modelSupportsChatTools(model.id, model.displayName));
  if (chatModels.length) return chatModels;
  return provider.models.filter((model) => modelSupportsChatTools(model.id, model.displayName));
}

const MODEL_CACHE_STALE_MS = 60 * 60 * 1000;
const REFRESH_FAILURE_COOLDOWN_MS = 60_000;
const inflightRefreshes = new Map<string, Promise<unknown>>();
const refreshFailureAt = new Map<string, number>();

export function providerModelCacheState(connectionId: string): "empty" | "stale" | "fresh" {
  const models = listProviderModels(connectionId);
  if (!models.length) return "empty";
  let newest = 0;
  for (const model of models) {
    const timestamp = Date.parse(model.discoveredAt);
    if (Number.isFinite(timestamp) && timestamp > newest) newest = timestamp;
  }
  if (!newest || Date.now() - newest > MODEL_CACHE_STALE_MS) return "stale";
  return "fresh";
}

export async function refreshProviderModels(connection: ProviderConnectionWithSecret) {
  const models = await discoverProviderModels(connection);
  const provider = getProviderDefinition(connection.providerKey);
  return persistDiscoveredModels(
    connection.id,
    models.map((model) => ({
      ...model,
      capabilities: {
        ...provider?.capabilities,
        ...(model.capabilities || {}),
      },
    })),
  );
}

export function scheduleProviderModelRefresh(connection: ProviderConnectionWithSecret) {
  const existing = inflightRefreshes.get(connection.id);
  if (existing) return existing;
  const failedAt = refreshFailureAt.get(connection.id);
  if (failedAt && Date.now() - failedAt < REFRESH_FAILURE_COOLDOWN_MS) {
    return Promise.resolve(listProviderModels(connection.id));
  }
  const promise = refreshProviderModels(connection)
    .then((models) => {
      refreshFailureAt.delete(connection.id);
      return models;
    })
    .catch(() => {
      refreshFailureAt.set(connection.id, Date.now());
      return listProviderModels(connection.id);
    })
    .finally(() => {
      inflightRefreshes.delete(connection.id);
    });
  inflightRefreshes.set(connection.id, promise);
  return promise;
}

export function persistDiscoveredModels(
  connectionId: string,
  models: Array<{
    id: string;
    displayName: string;
    description?: string;
    contextWindow?: number;
    contextWindowDiscovered?: boolean;
    contextWindowSource?: ProviderModelDefinition["contextWindowSource"];
    maxOutputTokens?: number;
    capabilities?: ProviderModel["capabilities"];
    parameters?: ProviderModelDefinition["parameters"];
    defaultParams?: ProviderModelDefinition["defaultParams"];
    tags?: string[];
  }>,
) {
  const previous = listProviderModels(connectionId);
  const previousById = new Map(previous.map((model) => [model.id, model]));
  const persisted = models.map((model) => {
    const stored = previousById.get(model.id);
    const currentSource = model.contextWindowSource;
    const storedSource = stored?.contextWindowSource;
    const currentAuthoritative = currentSource === "provider" || currentSource === "runtime" || currentSource === "registry";
    const storedAuthoritative = storedSource === "provider" || storedSource === "runtime" || storedSource === "stored-provider";
    const contextWindow = currentAuthoritative && model.contextWindow
      ? model.contextWindow
      : storedAuthoritative && stored?.contextWindow
        ? stored.contextWindow
        : model.contextWindow || (storedSource !== "inferred" ? stored?.contextWindow : undefined);
    const contextWindowSource = contextWindow === model.contextWindow && model.contextWindow
      ? currentSource
      : contextWindow === stored?.contextWindow
        ? storedSource || "stored-provider" as const
        : undefined;
    return {
      id: model.id,
      displayName: model.displayName,
      description: model.description,
      capabilities: model.capabilities,
      ...(contextWindow ? { contextWindow } : {}),
      ...(contextWindowSource ? { contextWindowSource } : {}),
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(model.parameters ? { parameters: model.parameters } : {}),
      ...(model.defaultParams ? { defaultParams: model.defaultParams } : {}),
      ...(model.tags ? { tags: model.tags } : {}),
    };
  });
  saveProviderModels(connectionId, persisted);
  return persisted;
}

export function providerModelsForConnection(connection: ProviderConnectionWithSecret) {
  const provider = getProviderDefinition(connection.providerKey);
  if (!provider) return [] as ProviderModel[];
  const discovered = listProviderModels(connection.id);
  const sourceModels: ProviderModelDefinition[] = discovered.length
    ? discovered.map((model) => {
    const catalog = provider.models.find((candidate) => candidate.id === model.id);
        const family = getProviderModelDefinition(provider.key, model.id);
        return {
          ...(family || {}),
          ...(catalog || {}),
          id: model.id,
          displayName: model.displayName,
          description: model.description || catalog?.description,
          ...(() => {
            const metadata = resolveModelContextMetadata({
              connection,
              modelId: model.id,
              displayName: model.displayName,
              storedContextWindow: model.contextWindow,
              storedContextWindowSource: model.contextWindowSource,
              catalogContextWindow: catalog?.contextWindow || family?.contextWindow,
              allowInference: false,
            });
            return {
              ...(metadata.contextWindow ? { contextWindow: metadata.contextWindow, contextWindowSource: metadata.source } : {}),
              ...(model.maxOutputTokens || metadata.maxOutputTokens
                ? { maxOutputTokens: model.maxOutputTokens || metadata.maxOutputTokens }
                : {}),
            };
          })(),
          capabilities: {
            ...provider.capabilities,
            ...(family?.capabilities || {}),
            ...(catalog?.capabilities || {}),
            ...(model.capabilities || {}),
          },
          ...(model.parameters ? { parameters: model.parameters } : {}),
          ...(model.defaultParams ? { defaultParams: model.defaultParams } : {}),
          ...(model.tags ? { tags: model.tags } : {}),
        };
      })
    : provider.models.map((model) => {
        const metadata = resolveModelContextMetadata({
          connection,
          modelId: model.id,
          displayName: model.displayName,
          catalogContextWindow: model.contextWindow,
        });
        return {
          ...model,
          ...(metadata.contextWindow ? { contextWindow: metadata.contextWindow, contextWindowSource: metadata.source } : {}),
          ...(model.maxOutputTokens || metadata.maxOutputTokens
            ? { maxOutputTokens: model.maxOutputTokens || metadata.maxOutputTokens }
            : {}),
        };
      });
  return sourceModels.map((model) => ({
    ...model,
    capabilities: getVerifiedProviderCapabilities(provider.key, model.id)?.verified ?? provider.capabilities,
    key: modelKey(provider.key, model.id, connection.id),
    providerKey: provider.key,
    providerName: provider.name,
    connectionId: connection.id,
    connectionLabel: connection.label,
    source: discovered.length ? "discovered" as const : "catalog" as const,
  }));
}

export async function testProviderConnection(connection: ProviderConnectionWithSecret) {
  const provider = getProviderDefinition(connection.providerKey);
  if (!provider) throw new Error(`Unknown provider: ${connection.providerKey}`);
  if (connection.providerKey === "cursor") {
    if (!connection.secret?.trim()) throw new Error("Cursor requires an API key.");
    const models = await Cursor.models.list({ apiKey: connection.secret.trim() });
    if (!models.length) throw new Error("Cursor returned no models for this connection.");
    return { ok: true, detail: `${models.length} models available.` };
  }
  if (connection.authType === "oauth") {
    if (connection.providerKey === "codex") {
      if (!connection.secret) throw new Error("OAuth connection is not completed.");
      readCodexOAuthCredentials(connection.secret, { allowExpired: true });
    } else if (!connection.secret) {
      throw new Error("OAuth connection is not completed.");
    }
    return { ok: true, detail: `${provider.name} OAuth credentials are configured.` };
  }
  if (connection.providerKey === "google" && connection.authType === "vertex_adc") {
    if (typeof connection.config.project !== "string" || !connection.config.project.trim()) {
      throw new Error("Vertex/ADC connections require a GCP project.");
    }
    return { ok: true, detail: "Google Vertex/ADC configuration is ready." };
  }
  if (provider.kind === "codex-agent") {
    if (connection.authType === "account") {
      if (!connection.secret) throw new Error("Codex account authentication requires auth.json content.");
      JSON.parse(connection.secret);
    }
    if (connection.authType === "api_key" && !connection.secret) {
      throw new Error("Codex API-key authentication requires a key.");
    }
    return { ok: true, detail: "Official Codex credentials are configured." };
  }
  if (provider.kind === "claude-agent") {
    if (!connection.secret) throw new Error("Claude Code requires an Anthropic API key.");
    return { ok: true, detail: "Anthropic API key is configured for Claude Code." };
  }
  if (provider.kind === "antigravity-agent") {
    if (!connection.secret && connection.authType !== "vertex_adc") {
      throw new Error("Antigravity connection credentials are not configured.");
    }
    if (connection.authType === "api_key" && !connection.secret) {
      throw new Error("Antigravity SDK API-key authentication requires a Gemini key.");
    }
    if (connection.authType === "vertex_adc" && !connection.config.project) {
      throw new Error("Vertex/ADC connections require a GCP project in connection settings.");
    }
    return { ok: true, detail: "Supported Antigravity SDK credentials are configured." };
  }
  const models = await discoverProviderModels(connection);
  return {
    ok: true,
    detail: `${models.length} model${models.length === 1 ? "" : "s"} available.`,
  };
}
