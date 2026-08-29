const KNOWN_WINDOWS: Array<{ test: RegExp; tokens: number }> = [
  { test: /grok-3-mini/i, tokens: 131_072 },
  { test: /grok/i, tokens: 2_000_000 },
  { test: /gemini|gemma/i, tokens: 1_048_576 },
  { test: /claude/i, tokens: 200_000 },
  { test: /gpt-4\.1/i, tokens: 1_048_576 },
  { test: /gpt-4o|o3|o4/i, tokens: 200_000 },
  { test: /gpt-5\.6/i, tokens: 1_050_000 },
  { test: /gpt-5\.5/i, tokens: 1_050_000 },
  { test: /gpt-5\.4-(?:mini|nano)/i, tokens: 400_000 },
  { test: /gpt-5\.4/i, tokens: 1_050_000 },
  { test: /gpt-5|codex/i, tokens: 400_000 },
  // z.ai fallback values are used only when discovery did not return a
  // context window. GLM-4.5 is 128K; GLM-4.6+ / GLM-5.x are 200K.
  { test: /glm[-_. ]?4\.5\b/i, tokens: 128_000 },
  { test: /glm[-_. ]?(?:4\.[67]|5(?:\.\d+)?)(?:\b|[-_. ])/i, tokens: 200_000 },
  { test: /glm|zai/i, tokens: 200_000 },
  { test: /composer/i, tokens: 200_000 },
  { test: /qwen|llama|mistral|deepseek/i, tokens: 128_000 },
];

/** Shared context-pressure policy used by both the runner and the composer UI.
 * Keeping these values in one place prevents the indicator from saying a chat
 * is safe while the runner has already decided it needs compaction (or vice
 * versa). */
export const CONTEXT_COMPACT_RATIO = 0.80;
export const CONTEXT_CRITICAL_RATIO = 0.90;
export const CONTEXT_HEADROOM_RATIO = 0.15;
export type ContextMode = "normal" | "limited";

/** Explicit mode selection is intentionally provider-neutral. */
export function contextModeOf(
  params?: ReadonlyArray<{ id: string; value: string }> | null,
): ContextMode {
  const value = params?.find((param) =>
    param.id === "contextMode" || param.id === "context_mode",
  )?.value?.trim().toLowerCase();
  return value === "limited" ? "limited" : "normal";
}

/** Budget reserved for provider framing/output so the input never reaches the hard limit. */
export function effectiveContextBudget(
  contextWindow: number | undefined,
  mode: ContextMode = "normal",
  reservedTokens = 0,
): number {
  if (!Number.isFinite(contextWindow) || !contextWindow || contextWindow <= 0) return 0;
  const modeRatio = mode === "limited" ? 0.55 : 1;
  return Math.max(
    1,
    Math.floor(contextWindow * modeRatio * (1 - CONTEXT_HEADROOM_RATIO) - Math.max(0, reservedTokens)),
  );
}

/** Conservative estimate that includes nested tool inputs and results. */
export function estimateContextTokens(value: unknown): number {
  let serialized: string;
  if (typeof value === "string") serialized = value;
  else {
    try {
      serialized = JSON.stringify(value) || "";
    } catch {
      serialized = String(value ?? "");
    }
  }
  return Math.max(1, Math.ceil(serialized.length / 4));
}

export function contextPressure(used: number, total: number) {
  const known = Number.isFinite(total) && total > 0;
  const ratio = known ? Math.max(0, used / total) : 0;
  return {
    known,
    ratio,
    usedPercent: known ? Math.min(100, ratio * 100) : 0,
    compactRecommended: known && ratio >= CONTEXT_COMPACT_RATIO,
    critical: known && ratio >= CONTEXT_CRITICAL_RATIO,
    overflow: known && ratio > 1,
  };
}

/** Known context-tier variants per model family. Ordered ascending by price;
 * the first entry is the default tier used when the model id carries no suffix.
 * Prices (when present) are per 1M output tokens, USD, informational only. */
export type ContextTier = {
  /** Suffix appended to the model id, e.g. "200k" or "1m". */
  suffix: string;
  tokens: number;
  label: string;
  /** Optional price hint per 1M output tokens (USD). */
  priceHint?: string;
};

const TIERS_200K_1M: ContextTier[] = [
  { suffix: "200k", tokens: 200_000, label: "200K", priceHint: "base price" },
  { suffix: "1m", tokens: 1_000_000, label: "1M", priceHint: "premium price" },
];

const KNOWN_TIERS: Array<{ test: RegExp; tiers: ContextTier[] }> = [
  // NOTE: intentionally no GLM entries — z.ai GLM models expose a single
  // context window per model id; suffix variants like "-1m" are rejected by
  // the API. Only families with REAL selectable tiers belong here.
  // Gemini ships real long-context variants (e.g. gemini-1.5/2.5-pro).
  { test: /\bgemini-(1\.5|2\.5)-pro\b/i, tiers: TIERS_200K_1M },
];

const TIER_SUFFIX_PATTERN = /-(200k|1m)$/i;

const CONTEXT_WINDOW_KEYS = [
  "contextWindow",
  "context_window",
  "maxInputTokens",
  "max_input_tokens",
  "inputTokenLimit",
  "input_token_limit",
  "max_context_length",
  "context_length",
  "max_model_len",
  "maxModelLen",
  "n_ctx",
  "contextLength",
  "context_tokens",
  "max_input_token_len",
] as const;

function asContextWindow(entry: unknown): number | undefined {
  if (typeof entry === "number" && Number.isFinite(entry) && entry >= 1_024) {
    return Math.round(entry);
  }
  if (typeof entry !== "string") return undefined;
  const trimmed = entry.trim().replace(/_/g, "").replace(/,/g, "");
 if (!trimmed || /^(?:max|unlimited)$/i.test(trimmed)) return undefined;
  const suffix = trimmed.match(/^([\d.]+)\s*([km])$/i);
  if (suffix) {
    const amount = Number(suffix[1]);
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    const multiplier = suffix[2].toLowerCase() === "m" ? 1_000_000 : 1_000;
    const tokens = Math.round(amount * multiplier);
    return tokens >= 1_024 ? tokens : undefined;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) && numeric >= 1_024 ? Math.round(numeric) : undefined;
}

/** Read a provider-reported context window from a model-list payload. Never infers. */
export function contextWindowOf(value: unknown, depth = 0): number | undefined {
  if (depth > 3 || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const nested = [
    item.metadata,
    item.limits,
    item.model_info,
    item.modelInfo,
    item.info,
    item.architecture,
    item.top_provider,
    item.spec,
    item.capabilities,
    item.parameters && !Array.isArray(item.parameters) ? item.parameters : undefined,
  ].filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) as Record<string, unknown>[];
  const sources = [item, ...nested];
  for (const source of sources) {
    for (const key of CONTEXT_WINDOW_KEYS) {
      const parsed = asContextWindow(source[key]);
      if (parsed) return parsed;
    }
  }
  for (const source of nested) {
    const nestedWindow = contextWindowOf(source, depth + 1);
    if (nestedWindow) return nestedWindow;
  }
  return undefined;
}

function leafModelId(modelId?: string | null): string {
  const raw = (modelId || "").trim();
  if (!raw) return "";
  const parts = raw.split(":");
  if (parts.length >= 3) return parts.slice(2).join(":");
  if (parts.length === 2) return parts[1] || raw;
  return raw;
}

export function inferContextWindow(modelId?: string | null, displayName?: string | null): number | undefined {
  const haystack = `${leafModelId(modelId)} ${displayName || ""}`.trim();
  if (!haystack) return undefined;
  // An explicit tier suffix wins over the family default.
  const suffixMatch = haystack.match(TIER_SUFFIX_PATTERN);
  if (suffixMatch) {
    return suffixMatch[1].toLowerCase() === "1m" ? 1_000_000 : 200_000;
  }
  const match = KNOWN_WINDOWS.find((entry) => entry.test.test(haystack));
  return match?.tokens;
}

export function resolveContextTotal(catalog: number | undefined, _used: number): number {
  // A reported/catalogued maximum is a maximum, not a value to stretch to
  // match observed usage. The UI caps the ring at 100% and surfaces overflow
  // explicitly so stale/mismatched usage never turns into a fantasy window.
  if (typeof catalog === "number" && Number.isFinite(catalog) && catalog > 0) {
    return Math.round(catalog);
  }
  return 0;
}

export function contextWindowForModel(
  model: { id?: string; displayName?: string; contextWindow?: number } | null | undefined,
): number | undefined {
  const catalog = model?.contextWindow;
  const raw = typeof catalog === "number" && Number.isFinite(catalog) && catalog > 8_000
    ? Math.round(catalog)
    : inferContextWindow(model?.id, model?.displayName);
  return typeof raw === "number" ? raw : undefined;
}

/** Resolve the effective window for the exact selected model variant.
 * A model's explicit `context` parameter wins over catalog/family defaults.
 * This is important for providers such as Cursor that expose 272K/1M variants
 * under the same model id. */
export function contextWindowForSelection(
  model: {
    id?: string;
    displayName?: string;
    contextWindow?: number;
    providerId?: string;
    defaultParams?: ReadonlyArray<{ id: string; value: string }>;
  } | null | undefined,
  params?: ReadonlyArray<{ id: string; value: string }> | null,
): number | undefined {
  const isContextParam = (id: string) => id === "context" || id === "contextWindow" || id === "context_window";
  const contextValue =
    params?.find((param) => isContextParam(param.id))?.value ||
    model?.defaultParams?.find((param) => isContextParam(param.id))?.value;
  const normalizedContextValue = contextValue?.trim().toLowerCase();
 if (normalizedContextValue === "max" || normalizedContextValue === "unlimited") {
    return contextWindowForModel(model);
  }
  const selectedWindow = asContextWindow(contextValue);
  if (selectedWindow) return selectedWindow;
 if (contextValue?.trim()) return undefined;

 return contextWindowForModel(model);
}

/** Context tiers available for a model family, or null when it has a single tier. */
export function contextTiersForModel(
  model: { id?: string; displayName?: string } | null | undefined,
): ContextTier[] | null {
  const haystack = `${model?.id || ""} ${model?.displayName || ""}`.trim();
  if (!haystack) return null;
  // Tier suffix already baked into the id → single concrete tier.
  if (TIER_SUFFIX_PATTERN.test(haystack)) return null;
  const entry = KNOWN_TIERS.find((candidate) => candidate.test.test(haystack));
  return entry ? entry.tiers : null;
}

/** Detect an explicit context tier already encoded in a model id. */
export function contextTierOfModelId(
  modelId: string,
): ContextTier | null {
  const match = modelId.match(TIER_SUFFIX_PATTERN);
  if (!match) return null;
  const suffix = match[1].toLowerCase();
  const tier = TIERS_200K_1M.find((entry) => entry.suffix === suffix);
  return tier || null;
}

/** Strip a context-tier suffix (e.g. "-1m") from a model id. */
export function stripContextTierSuffix(modelId: string): string {
  return modelId.replace(TIER_SUFFIX_PATTERN, "");
}

/** Format a token count the way the pickers display it: 200K / 1M / 128K. */
export function formatContextWindow(tokens: number | undefined | null): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return "";
  const snapped = tokens;
  if (snapped >= 1_000_000) {
    if (snapped === 1_000_000 || snapped === 1_048_576) return "1M";
    const millions = Math.round((snapped / 1_000_000) * 100) / 100;
    return `${Number.isInteger(millions) ? millions : String(millions).replace(/0$/, "")}M`;
  }
  if (snapped >= 10_000) return `${Math.round(snapped / 1_000)}K`;
  if (snapped >= 1_000) {
    const thousands = snapped / 1_000;
    return Number.isInteger(thousands) ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return String(Math.round(snapped));
}

export function lastMeasuredInputTokens(
  chat: {
    contextUsedTokens?: number;
    messages?: Array<{
      runMetadata?: {
        inputTokens?: number;
        contextUsedTokens?: number;
        totalProcessedTokens?: number;
      };
    }>;
  } | null | undefined,
): number | undefined {
  const fromChat = chat?.contextUsedTokens;
  if (typeof fromChat === "number" && Number.isFinite(fromChat) && fromChat > 0) return fromChat;
  const messages = chat?.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const meta = messages[index]?.runMetadata;
    const tokens =
      meta?.contextUsedTokens ??
      meta?.totalProcessedTokens ??
      meta?.inputTokens;
    if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) return tokens;
  }
  return undefined;
}
