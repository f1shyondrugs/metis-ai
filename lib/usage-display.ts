export type UsageWindow = {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
};

export type UsageProvider = {
  key: string;
  name: string;
  connectionId?: string;
  modelId?: string;
  source?: "provider" | "dashboard" | "local";
  status: "live" | "stale" | "error" | "no_auth" | "unsupported";
  planLabel?: string;
  windows: UsageWindow[];
  extra?: Record<string, string | number | null>;
  error?: string;
};

export type UsageSnapshot = {
  providers: UsageProvider[];
  fetchedAt: string;
  refreshing?: boolean;
};

export type UsageSelection = {
  providerId?: string | null;
  providerName?: string | null;
  connectionLabel?: string | null;
  connectionId?: string | null;
  modelId?: string | null;
};

export function usageKeyForProvider(providerId?: string | null): string | null {
  const key = (providerId || "").trim().toLowerCase();
  if (!key) return null;
  if (key === "cursor" || key === "cursor-agent" || key === "cursor-sdk") return "cursor";
  if (key === "codex" || key === "chatgpt" || key === "openai-codex") return "codex";
  if (key === "antigravity" || key === "agy") return "antigravity";
  if (key === "zai" || key === "z.ai" || key === "z-ai" || key === "glm" || key === "zhipu") return "zai";
  return null;
}

export function usageKeyForSelection(selection: UsageSelection): string | null {
  const direct = usageKeyForProvider(selection.providerId);
  if (direct) return direct;
   const haystack = [selection.providerId, selection.providerName, selection.connectionLabel, selection.modelId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!haystack) return null;

  // The local Samuel gateway exposes several plan-backed aliases through a
  // generic OpenAI-compatible connection. Resolve those aliases to the real
  // quota owner so the footer follows the backend that is actually billed.
  const localGateway = /samuel ai gateway/i.test(selection.connectionLabel || "");
  const model = (selection.modelId || "").toLowerCase();
  if (localGateway && /(?:^|[-_.])(agy|gemini)(?:[-_.]|$)/i.test(model)) return "antigravity";
  if (localGateway && /(?:^|[-_.])(glm|zai|z-ai)(?:[-_.]|$)/i.test(model)) return "zai";
  if (localGateway && /^gpt[-_.]?5(?:[.\-_]|$)/i.test(model)) return "codex";
  if (/\bz\.?ai\b|\bz-ai\b|\bglm(?:[-_. ]?\d)?/i.test(haystack)) return "zai";
  if (/\bantigravity\b|\bagy\b/i.test(haystack)) return "antigravity";
  if (/\bcodex\b|\bchatgpt\b/i.test(haystack)) return "codex";
  if (/\bcursor\b/i.test(haystack)) return "cursor";
  return null;
}

function normalizedUsageModelId(value?: string | null) {
  const raw = (value || "").trim().toLowerCase();
  if (!raw) return "";
  const parts = raw.split(":");
  const leaf = parts.length >= 3 ? parts.slice(2).join(":") : parts.length === 2 ? parts[1] : raw;
  return leaf.replace(/[^a-z0-9]+/g, "");
}

export function windowsWithData(windows: UsageWindow[]): Array<UsageWindow & { usedPercent: number }> {
  return windows.filter(
    (window): window is UsageWindow & { usedPercent: number } =>
      typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent),
  );
}

export function selectPrimaryUsageWindow(windows: UsageWindow[]): (UsageWindow & { usedPercent: number }) | null {
  const usable = windowsWithData(windows);
  if (!usable.length) return null;
  // The compact gauge must surface the most constrained bucket. A weekly
 // window can be healthier than the rolling 5h window (and vice versa), so
 // choosing by label makes the displayed percentage misleading.
 return usable.reduce((primary, window) =>
  window.usedPercent > primary.usedPercent ? window : primary,
 );
}

export function percentLeft(usedPercent: number): number {
  return Math.min(100, Math.max(0, 100 - usedPercent));
}

export const QUOTA_WARN_REMAINING_PCT = 10;

export type QuotaAlert = {
  providerKey: string;
  providerName: string;
  windowLabel: string;
  remainingPct: number;
  resetsAt: string | null;
};

/** Official dashboard quotas that have fallen to the remaining-percent threshold.
 * Local gateway telemetry is ignored so we never warn on made-up activity data. */
export function lowQuotaAlerts(
  snapshot: UsageSnapshot | null,
  remainingPct = QUOTA_WARN_REMAINING_PCT,
): QuotaAlert[] {
  if (!snapshot) return [];
  const alerts: QuotaAlert[] = [];
  for (const provider of snapshot.providers) {
    if (provider.source === "local") continue;
    const official = ["cursor", "codex", "zai", "antigravity"].includes(provider.key)
      || provider.source === "dashboard";
    if (!official) continue;
    if (provider.status !== "live" && provider.status !== "stale") continue;
    const primary = selectPrimaryUsageWindow(provider.windows);
    if (!primary) continue;
    const left = percentLeft(primary.usedPercent);
    if (left > remainingPct) continue;
    alerts.push({
      providerKey: provider.key,
      providerName: provider.name,
      windowLabel: primary.label,
      remainingPct: left,
      resetsAt: primary.resetsAt,
    });
  }
  return alerts;
}

export function formatResetAt(resetsAt: string | null | undefined): string | null {
  if (!resetsAt) return null;
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return "reset pending";
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function parseCursorUsageBody(body: unknown): {
  windows: UsageWindow[];
  planLabel?: string;
  extra?: Record<string, string | number | null>;
} | null {
  const rawRoot = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const root = rawRoot && rawRoot.data && typeof rawRoot.data === "object"
    ? rawRoot.data as Record<string, unknown>
    : rawRoot;
  if (!root) return null;
  const asRecord = (value: unknown) =>
    value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const asFiniteNumber = (value: unknown) => {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const asFinitePercent = (value: unknown) => {
    const n = asFiniteNumber(value);
    return n === null ? null : Math.round(Math.min(100, Math.max(0, n)));
  };
  const individual = asRecord(root.individualUsage);
  const plan = asRecord(individual?.plan)
    || asRecord(individual?.planUsage)
    || asRecord(individual?.includedUsage)
    || asRecord(individual?.included)
    || asRecord(root.planUsage)
    || asRecord(root.plan)
    || asRecord(root.usage);
  const onDemand = asRecord(individual?.onDemand)
    || asRecord(individual?.onDemandUsage)
    || asRecord(individual?.extraUsage)
    || asRecord(individual?.credits)
    || asRecord(root.onDemand)
    || asRecord(root.onDemandUsage)
    || asRecord(root.extraUsage)
    || asRecord(root.credits);
  const membership = typeof root.membershipType === "string" ? root.membershipType : undefined;
  const resetValue = root.billingCycleEnd ?? root.billing_cycle_end ?? root.resetAt ?? root.reset_at;
  let resetsAt: string | null = typeof resetValue === "string" ? resetValue : null;
  const resetNumber = asFiniteNumber(resetValue);
  if (!resetsAt && resetNumber !== null && resetNumber > 0) {
    resetsAt = new Date(resetNumber > 1e12 ? resetNumber : resetNumber * 1000).toISOString();
  }
  const windows: UsageWindow[] = [];
  const push = (label: string, usedPercent: number | null) => {
    if (usedPercent === null) return;
    windows.push({ label, usedPercent, resetsAt });
  };
  if (plan) {
    push("included", asFinitePercent(
      plan.totalPercentUsed ??
      plan.total_percent_used ??
      plan.percentUsed ??
      plan.includedPercentUsed ??
      plan.included_percent_used,
    ));
    push("auto", asFinitePercent(plan.autoPercentUsed ?? plan.auto_percent_used));
    push("api", asFinitePercent(plan.apiPercentUsed ?? plan.api_percent_used));
    if (!windows.length) {
      const used = asFiniteNumber(plan.used ?? plan.usedAmount);
      const limit = asFiniteNumber(plan.limit ?? plan.total);
      if (used !== null && limit !== null && limit > 0) {
        push("monthly", Math.round((used / limit) * 100));
      }
    }
  }
  if (onDemand) {
    const used = asFiniteNumber(onDemand.used ?? onDemand.usedAmount);
    const limit = asFiniteNumber(onDemand.limit ?? onDemand.total);
    const percent = asFinitePercent(
      onDemand.percentUsed ??
      onDemand.percentage ??
      onDemand.onDemandPercentUsed ??
      onDemand.on_demand_percent_used,
    );
    if (percent !== null) push("on-demand", percent);
    else if (used !== null && limit !== null && limit > 0) push("on-demand", Math.round((used / limit) * 100));
  }
  if (!windows.length) return null;
  const extra: Record<string, string | number | null> = {};
  const planUsed = asFiniteNumber(plan?.used ?? plan?.usedAmount);
  const planLimit = asFiniteNumber(plan?.limit ?? plan?.total);
  const onDemandUsed = asFiniteNumber(onDemand?.used ?? onDemand?.usedAmount);
  const onDemandLimit = asFiniteNumber(onDemand?.limit ?? onDemand?.total);
  const includedUsed = asFiniteNumber(plan?.used ?? plan?.usedAmount ?? plan?.includedUsed);
  const includedLimit = asFiniteNumber(plan?.limit ?? plan?.total ?? plan?.includedLimit);
  if (planUsed !== null) extra.planUsed = planUsed;
  if (planLimit !== null) extra.planLimit = planLimit;
  if (onDemandUsed !== null) extra.onDemandUsed = onDemandUsed;
  if (includedUsed !== null) extra.includedUsed = includedUsed;
  if (includedLimit !== null) extra.includedLimit = includedLimit;
  if (onDemandLimit !== null) extra.onDemandLimit = onDemandLimit;
  const money = [
    ["onDemandUsedUsd", onDemand?.usedUsd ?? onDemand?.used_usd ?? onDemand?.spend],
    ["onDemandLimitUsd", onDemand?.limitUsd ?? onDemand?.limit_usd ?? onDemand?.budget],
  ] as const;
  for (const [key, value] of money) {
    const number = asFiniteNumber(value);
    if (number !== null) extra[key] = number;
  }
  return {
    windows,
    planLabel: membership ? membership.charAt(0).toUpperCase() + membership.slice(1) : undefined,
    extra: Object.keys(extra).length ? extra : undefined,
  };
}

export function matchUsageProvider(
  providers: UsageProvider[],
  selection?: string | UsageSelection | null,
): UsageProvider | null {
  const normalized = typeof selection === "string"
    ? { providerId: selection }
    : selection || {};
  const key = usageKeyForSelection(normalized);
  const modelKey = normalizedUsageModelId(normalized.modelId);
  if (normalized.connectionId && modelKey) {
    const exact = providers.find((provider) =>
      provider.connectionId === normalized.connectionId &&
      normalizedUsageModelId(provider.modelId || (typeof provider.extra?.model === "string" ? provider.extra.model : "")) === modelKey,
    );
    if (exact) return exact;
  }
  if (key && modelKey) {
    const exact = providers.find((provider) =>
      provider.key === key &&
      normalizedUsageModelId(provider.modelId || (typeof provider.extra?.model === "string" ? provider.extra.model : "")) === modelKey,
    );
    if (exact) return exact;
  }
  if (normalized.connectionId) {
    const connection = providers.find((provider) => provider.connectionId === normalized.connectionId);
    if (connection) return connection;
  }
  if (key) {
    const official = providers.find((provider) => provider.key === key);
    if (official) return official;
  }

  // If the selected backend has no official percentage/quota API, still expose
  // Metis' read-only recent telemetry for that exact model. The gauge stays
  // neutral because this is activity data, not a made-up quota percentage.
  if (!modelKey) return null;
  return providers.find((provider) => {
    if (!provider.key.startsWith("gateway:") && !provider.key.startsWith("local:")) return false;
    const candidate = normalizedUsageModelId(
      typeof provider.extra?.model === "string" ? provider.extra.model : provider.key.split(":").slice(2).join(":"),
    );
    return candidate === modelKey;
  }) || null;
}
