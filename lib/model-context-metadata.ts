import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import type { ProviderConnection, ProviderModelDefinition } from "@/lib/providers/types";
import { inferContextWindow } from "@/lib/context-window";

export type ContextWindowSource =
  | "provider"
  | "runtime"
  | "stored-provider"
  | "registry"
  | "catalog"
  | "inferred";

export type ModelContextMetadata = {
  contextWindow?: number;
  maxOutputTokens?: number;
  source?: ContextWindowSource;
};

type RegistryEntry = { contextWindow?: number; maxOutputTokens?: number };
type ContextRegistry = {
  fetchedAt?: string;
  providers?: Record<string, Record<string, RegistryEntry>>;
};

let registryCache: { mtimeMs: number; value: ContextRegistry } | null = null;

function finitePositive(value: unknown, minimum = 1_024): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
    ? Math.round(value)
    : undefined;
}

function registryPath() {
  return path.join(config.root, "data", "model-context-registry.json");
}

function loadRegistry(): ContextRegistry {
  try {
    const file = registryPath();
    const mtimeMs = statSync(file).mtimeMs;
    if (registryCache?.mtimeMs === mtimeMs) return registryCache.value;
    const value = JSON.parse(readFileSync(file, "utf8")) as ContextRegistry;
    registryCache = { mtimeMs, value };
    return value;
  } catch {
    return {};
  }
}

function normalized(value: string | undefined | null) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hostOf(baseUrl?: string) {
  try {
    return baseUrl ? new URL(baseUrl).hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * Provider registry aliases are intentionally conservative. A custom OpenAI-
 * compatible endpoint is only mapped when its hostname/label identifies the
 * upstream. We never scan every provider and guess based on model id alone.
 */
export function contextRegistryProviderCandidates(
  connection: Pick<ProviderConnection, "providerKey" | "slug" | "label" | "baseUrl">,
): string[] {
  const candidates = new Set<string>();
  const providerKey = normalized(connection.providerKey);
  const slug = normalized(connection.slug);
  const label = normalized(connection.label);
  const host = hostOf(connection.baseUrl);

  if (providerKey && providerKey !== "compatible") candidates.add(providerKey);
  if (slug) candidates.add(slug);
  if (providerKey === "codex") candidates.add("openai");
  if (providerKey === "claude-code") candidates.add("anthropic");
  if (providerKey === "antigravity") {
    candidates.add("google");
    candidates.add("anthropic");
    candidates.add("openai");
  }

  if (providerKey === "compatible") {
    if (host === "api.z.ai" || host.endsWith(".z.ai") || /\bz-?ai\b/.test(label)) {
      // The coding endpoint has its own catalog and may expose newer models.
      if ((connection.baseUrl || "").includes("/coding/")) candidates.add("zai-coding-plan");
      candidates.add("zai");
      candidates.add("zhipuai");
      candidates.add("zhipuai-coding-plan");
    }
    if (host.includes("openrouter.ai") || label.includes("openrouter")) candidates.add("openrouter");
    if (host.includes("api.openai.com") || label === "openai") candidates.add("openai");
    if (host.includes("anthropic.com") || label.includes("anthropic")) candidates.add("anthropic");
    if (host.includes("googleapis.com") || label.includes("gemini") || label === "google") candidates.add("google");
    if (host.includes("x.ai") || label.includes("xai")) candidates.add("xai");
  }

  // Friendly labels/slugs sometimes include a provider prefix/suffix.
  for (const known of ["openrouter", "openai", "anthropic", "google", "zai", "xai", "opencode"]) {
    if (slug.includes(known) || label.includes(known)) candidates.add(known);
  }
  return [...candidates];
}

function registryModelEntry(providerKey: string, modelId: string): RegistryEntry | undefined {
  const models = loadRegistry().providers?.[providerKey];
  if (!models) return undefined;
  const exact = models[modelId];
  if (exact) return exact;

  // Compatible APIs sometimes prefix the upstream namespace while the direct
  // endpoint returns the bare model id (z-ai/glm-5.3 vs glm-5.3).
  const suffix = `/${modelId}`;
  const matches = Object.entries(models).filter(([id]) => id === modelId || id.endsWith(suffix));
  if (matches.length === 1) return matches[0]![1];
  return undefined;
}

export function lookupRegistryContextMetadata(
  connection: Pick<ProviderConnection, "providerKey" | "slug" | "label" | "baseUrl">,
  modelId: string,
): ModelContextMetadata {
  for (const providerKey of contextRegistryProviderCandidates(connection)) {
    const entry = registryModelEntry(providerKey, modelId);
    if (!entry) continue;
    const contextWindow = finitePositive(entry.contextWindow);
    const maxOutputTokens = finitePositive(entry.maxOutputTokens, 1);
    if (contextWindow || maxOutputTokens) {
      return {
        ...(contextWindow ? { contextWindow, source: "registry" as const } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      };
    }
  }
  return {};
}

/** Provider/runtime metadata wins. Static registry is a fallback, never an override. */
export function resolveModelContextMetadata(input: {
  connection: Pick<ProviderConnection, "providerKey" | "slug" | "label" | "baseUrl">;
  modelId: string;
  displayName?: string;
  providerContextWindow?: number;
  storedContextWindow?: number;
  storedContextWindowSource?: ContextWindowSource;
  catalogContextWindow?: number;
  maxOutputTokens?: number;
  allowInference?: boolean;
}): ModelContextMetadata {
  const live = finitePositive(input.providerContextWindow);
  if (live) {
    return {
      contextWindow: live,
      source: "provider",
      ...(finitePositive(input.maxOutputTokens, 1) ? { maxOutputTokens: finitePositive(input.maxOutputTokens, 1) } : {}),
    };
  }

  const stored = finitePositive(input.storedContextWindow);
  const storedSource = input.storedContextWindowSource;
  const storedIsProviderOwned = storedSource === "provider" || storedSource === "runtime" || storedSource === "stored-provider";
  const registry = lookupRegistryContextMetadata(input.connection, input.modelId);
  const catalog = finitePositive(input.catalogContextWindow);
  const inferred = input.allowInference === false
    ? undefined
    : inferContextWindow(input.modelId, input.displayName);

  if (stored && storedIsProviderOwned) {
    return {
      contextWindow: stored,
      source: storedSource || "stored-provider",
      ...(registry.maxOutputTokens ? { maxOutputTokens: registry.maxOutputTokens } : {}),
    };
  }
  if (registry.contextWindow) return registry;
  if (catalog) {
    return {
      contextWindow: catalog,
      source: "catalog",
      ...(registry.maxOutputTokens ? { maxOutputTokens: registry.maxOutputTokens } : {}),
    };
  }
  // Legacy rows written before provenance existed are a last-resort fallback:
  // useful for private/custom endpoints, but never allowed to override a known
  // upstream registry or current catalog entry.
  if (stored && storedSource !== "inferred") {
    return {
      contextWindow: stored,
      source: storedSource || "stored-provider",
      ...(registry.maxOutputTokens ? { maxOutputTokens: registry.maxOutputTokens } : {}),
    };
  }
  if (inferred) {
    return {
      contextWindow: inferred,
      source: "inferred",
      ...(registry.maxOutputTokens ? { maxOutputTokens: registry.maxOutputTokens } : {}),
    };
  }
  return registry.maxOutputTokens ? { maxOutputTokens: registry.maxOutputTokens } : {};
}

export function modelContextMetadataFromDefinition(
  connection: Pick<ProviderConnection, "providerKey" | "slug" | "label" | "baseUrl">,
  model: Pick<ProviderModelDefinition, "id" | "displayName" | "contextWindow" | "maxOutputTokens" | "contextWindowSource">,
): ModelContextMetadata {
  if (model.contextWindow) {
    return {
      contextWindow: model.contextWindow,
      source: model.contextWindowSource || "catalog",
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    };
  }
  return resolveModelContextMetadata({
    connection,
    modelId: model.id,
    displayName: model.displayName,
    catalogContextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
  });
}
