"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  formatResetAt,
  matchUsageProvider,
  percentLeft,
  selectPrimaryUsageWindow,
  windowsWithData,
  type UsageProvider,
  type UsageSelection,
  type UsageSnapshot,
} from "@/lib/usage-display";
import { CONTEXT_COMPACT_RATIO, CONTEXT_CRITICAL_RATIO, contextPressure, formatContextWindow } from "@/lib/context-window";

function formatTokenCount(value: number) {
  return formatContextWindow(value) || String(Math.round(value));
}

export type ContextBudgetState = "normal" | "unknown" | "stale" | "error" | "overflow" | "compacting";

export function contextBudgetState({
  used,
  effectiveInputBudget,
  measuredAt,
  error,
  compacting = false,
  now = Date.now(),
}: {
  used: number;
  effectiveInputBudget: number;
  measuredAt?: string;
  error?: string;
  compacting?: boolean;
  now?: number;
}): ContextBudgetState {
  if (error) return "error";
  if (!Number.isFinite(effectiveInputBudget) || effectiveInputBudget <= 0) return "unknown";
  if (contextPressure(used, effectiveInputBudget).overflow) return "overflow";
  if (compacting) return "compacting";
  if (measuredAt) {
    const measuredMs = Date.parse(measuredAt);
    if (Number.isFinite(measuredMs) && now - measuredMs > 15 * 60_000) return "stale";
  }
  return "normal";
}

function formatAge(value: string | undefined, now = Date.now()) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function contextStateLabel(state: ContextBudgetState) {
  return {
    normal: "Ready",
    unknown: "Unknown",
    stale: "Stale",
    error: "Error",
    overflow: "Overflow",
    compacting: "Compacting",
  }[state];
}

function thresholdColor(percentLeftValue: number) {
  if (percentLeftValue <= 10) return "text-red-400";
  return "text-foreground/80";
}

function usedBarColor(usedPercent: number) {
  if (usedPercent >= CONTEXT_CRITICAL_RATIO * 100) return "bg-red-400";
  if (usedPercent >= CONTEXT_COMPACT_RATIO * 100) return "bg-amber-400";
  return "bg-foreground/55";
}

export function ContextUsageText({
  used,
  total,
  modelMaximum,
  estimated,
  measuredAt,
  source,
  selectionLabel,
  compacting,
  error,
  className,
}: {
  used: number;
  total: number;
  modelMaximum?: number;
  estimated?: boolean;
  measuredAt?: string;
  source?: string;
  selectionLabel?: string;
  compacting?: boolean;
  error?: string;
  className?: string;
}) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const pressure = contextPressure(used, total);
  const state = contextBudgetState({ used, effectiveInputBudget: total, measuredAt, error, compacting });
  const remaining = pressure.known ? Math.max(0, total - used) : null;
  const remainingPct = pressure.known ? percentLeft(pressure.usedPercent) : null;
  const label = pressure.known ? `${formatTokenCount(used)} / ${formatTokenCount(total)}` : `${formatTokenCount(used)} / —`;
  const freshness = estimated ? "current draft" : formatAge(measuredAt);
  const stateClass = state === "overflow" || state === "error" ? "text-red-400" : state === "compacting" ? "text-amber-400" : "text-muted-foreground/65";
  return (
    <TooltipProvider>
      <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <button type="button" className={cn("inline-flex h-7 shrink-0 items-center rounded-md px-1 text-[11px] font-normal tabular-nums tracking-[-0.01em] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", pressure.critical ? "text-red-400" : `${stateClass} hover:text-muted-foreground`, className)} onClick={() => setTooltipOpen((open) => !open)} aria-label={pressure.known ? `Context: ${formatTokenCount(used)} of ${formatTokenCount(total)} effective input tokens used` : `Context: ${formatTokenCount(used)} tokens used; effective input budget unknown`}>
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" sideOffset={8} collisionPadding={8} arrowClassName="!bg-popover !fill-popover" className="w-64 max-w-[calc(100vw-1rem)] rounded-xl border border-border/60 bg-popover p-3 text-popover-foreground shadow-xl">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3"><span className="font-medium">Context budget</span><span className={cn("font-medium", stateClass)}>{contextStateLabel(state)}</span></div>
            {pressure.known ? <>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/15"><div className={cn("h-full rounded-full transition-[width,background-color] duration-500", usedBarColor(pressure.usedPercent))} style={{ width: `${pressure.usedPercent}%` }} /></div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground"><span>Input used</span><span className="text-right text-foreground tabular-nums">{formatTokenCount(used)} tokens</span><span>Effective input</span><span className="text-right text-foreground tabular-nums">{formatTokenCount(total)} tokens</span><span>Model maximum</span><span className="text-right text-foreground tabular-nums">{modelMaximum ? `${formatTokenCount(modelMaximum)} tokens` : "—"}</span><span>Remaining</span><span className="text-right text-foreground tabular-nums">{formatTokenCount(remaining ?? 0)} tokens</span></div>
              {pressure.overflow ? <p className="text-[10px] leading-snug text-red-400">Reported usage exceeds this model&apos;s known maximum.</p> : pressure.compactRecommended ? <p className="text-[10px] leading-snug text-muted-foreground">Metis can compact managed history before the next run when context pressure is high.</p> : null}
            </> : null}
            <div className="flex flex-wrap gap-x-2 gap-y-1 text-[10px] leading-snug text-muted-foreground"><span>Source: {source || (estimated ? "current chat estimate" : "last model run")}</span>{freshness ? <span>Freshness: {freshness}</span> : null}{selectionLabel ? <span>Selection: {selectionLabel}</span> : null}</div>
            {pressure.known ? <p className="text-[10px] leading-snug text-muted-foreground">{estimated ? "Estimated from the current chat until the next model run reports tokens." : "Measured from the input tokens of the last model run."} Managed-history compaction starts around {Math.round(CONTEXT_COMPACT_RATIO * 100)}%.</p> : <p className="text-[10px] leading-snug text-muted-foreground">Effective input budget is unknown; no percentage is shown.</p>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function quotaBarColor(percentLeftValue: number) {
  if (percentLeftValue <= 10) return "bg-red-400";
  return "bg-foreground/55";
}

function displayUsageExtra(provider: UsageProvider) {
  const labels: Record<string, string> = {
    planUsed: "Plan used",
    planLimit: "Plan limit",
    onDemandUsed: "Credits used",
    onDemandLimit: "Credit limit",
    credits: "Credits",
  };
  return Object.entries(provider.extra || {})
    .filter(([key, value]) => labels[key] && value !== null && value !== undefined)
    .map(([key, value]) => ({ key, label: labels[key], value }));
}

function UsageDetails({ provider }: { provider: UsageProvider }) {
  const status = String(provider.status);
  const usable = status === "live" || status === "stale" ? windowsWithData(provider.windows) : [];
  const primary = selectPrimaryUsageWindow(usable);
  const left = primary ? percentLeft(primary.usedPercent) : null;
  const statusLabel = status === "stale"
    ? "Stale"
    : status === "error"
      ? "Error"
      : status === "no_auth"
        ? "Not connected"
        : status === "unsupported"
          ? "Unsupported"
          : "Live";
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><p className="truncate font-medium">{provider.name}</p><p className="text-[10px] text-muted-foreground">Quota · {statusLabel}{provider.planLabel ? ` · ${provider.planLabel}` : ""}</p></div>
        {left !== null ? <span className={cn("shrink-0 font-medium tabular-nums", status === "stale" ? "text-muted-foreground" : thresholdColor(left))}>{left.toFixed(0)}% left</span> : <span className="shrink-0 text-[10px] text-muted-foreground">—</span>}
      </div>
      {usable.map((window) => {
        const remaining = percentLeft(window.usedPercent);
        const reset = formatResetAt(window.resetsAt);
        return <div key={`${provider.key}:${window.label}`} className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground"><span className="capitalize">{window.label}</span><span className="tabular-nums text-foreground">{remaining.toFixed(0)}% left</span></div>
          <div className="h-1 overflow-hidden rounded-full bg-foreground/10"><div className={cn("h-full rounded-full transition-[width,background-color] duration-500", quotaBarColor(remaining))} style={{ width: `${remaining}%` }} /></div>
          {reset ? <p className="text-[10px] text-muted-foreground">Resets in {reset}</p> : null}
        </div>;
      })}
      {!usable.length ? <p className="text-[10px] leading-snug text-muted-foreground">{status === "no_auth" ? "No authenticated quota source is connected." : status === "unsupported" ? "This connection does not expose a quota window." : provider.error ? `Live quota could not be loaded: ${provider.error}` : "No percentage quota is available. Metis will not invent one."}</p> : null}
      {displayUsageExtra(provider).length ? <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">{displayUsageExtra(provider).map(({ key, label, value }) => <span key={key}>{label}: <span className="tabular-nums text-foreground">{typeof value === "number" ? value.toLocaleString() : value}</span></span>)}</div> : null}
    </div>
  );
}

export function PlanUsageGauge({ provider, providerName, className }: { provider?: UsageProvider | null; providerName?: string; className?: string }) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const primary = provider ? selectPrimaryUsageWindow(provider.windows) : null;
  const left = primary ? percentLeft(primary.usedPercent) : null;
  const displayName = provider?.name || providerName || "Selected provider";
  const stale = provider?.status === "stale";
  return (
    <TooltipProvider>
      <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex h-7 shrink-0 items-center justify-center rounded-md px-1 text-[10px] font-normal tabular-nums tracking-[-0.015em] outline-none transition-[color,opacity] hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/70",
              left === null
                ? "text-muted-foreground/35"
                : left <= 10
                  ? "text-red-400"
                  : "text-muted-foreground/60",
              stale && "opacity-60",
              className,
            )}
            aria-label={left !== null ? `${displayName} usage: ${left.toFixed(0)}% left${stale ? ", stale" : ""}` : `${displayName} usage unavailable`}
            onClick={() => setTooltipOpen((open) => !open)}
          >
            {left !== null ? `${left.toFixed(0)}%` : "—"}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" sideOffset={8} collisionPadding={8} arrowClassName="!bg-popover !fill-popover" className="w-64 max-w-[calc(100vw-1rem)] rounded-xl border border-border/60 bg-popover p-3 text-popover-foreground shadow-xl">
          {provider ? <UsageDetails provider={provider} /> : <div className="space-y-1.5"><p className="font-medium">{displayName}</p><p className="text-[10px] leading-snug text-muted-foreground">Quota unavailable for this connection.</p></div>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function PlanUsageCardGauge({ provider }: { provider: UsageProvider }) {
  const primary = selectPrimaryUsageWindow(provider.windows);
  if (!primary) return null;
  const left = percentLeft(primary.usedPercent);
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className={cn("text-sm font-medium tabular-nums", thresholdColor(left))}>{left.toFixed(0)}% left</p>
        <p className="text-[10px] capitalize text-muted-foreground">{primary.label}</p>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
        <div className={cn("h-full rounded-full", quotaBarColor(left))} style={{ width: `${left}%` }} />
      </div>
    </div>
  );
}

export function PlanUsagePanel({
  snapshot,
  onRefresh,
}: {
  snapshot: UsageSnapshot | null;
  onRefresh?: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  const quotaProviders = snapshot?.providers.filter((provider) =>
    provider.key === "cursor" || provider.key === "codex" || provider.key === "zai" || provider.key === "antigravity",
  ) || [];
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Provider usage</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {snapshot?.refreshing ? "Refreshing live limits…" : snapshot ? `Updated ${formatAge(snapshot.fetchedAt) || "just now"}` : "Live limits from connected providers"}
          </p>
        </div>
        <button
          type="button"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted/30 hover:text-foreground disabled:opacity-40"
          onClick={() => void refresh()}
          disabled={!onRefresh || refreshing}
          aria-label="Refresh provider usage"
          title="Refresh provider usage"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </button>
      </div>
      {!snapshot || (snapshot.refreshing && quotaProviders.length === 0) ? (
        <div className="py-2 text-xs text-muted-foreground">Loading provider limits…</div>
      ) : (
        <div className="min-w-0 divide-y divide-border/45 border-y border-border/45">
          {quotaProviders.map((provider) => (
            <div key={provider.key} className="min-w-0 py-3 first:pt-3 last:pb-3">
              <UsageDetails provider={provider} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const USAGE_STORAGE_KEY = "metis:plan-usage:v1";
const USAGE_POLL_MS = 120_000;
let sharedSnapshot: UsageSnapshot | null = null;
const sharedListeners = new Set<(snapshot: UsageSnapshot | null) => void>();
let sharedTimer: ReturnType<typeof setInterval> | null = null;
let sharedInflight: Promise<void> | null = null;

function validUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<UsageSnapshot>;
  return Array.isArray(snapshot.providers) && typeof snapshot.fetchedAt === "string";
}

function publishUsageSnapshot(snapshot: UsageSnapshot) {
  sharedSnapshot = snapshot;
  if (typeof window !== "undefined") {
    try { window.localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* storage can be disabled */ }
  }
  for (const listener of sharedListeners) listener(snapshot);
}

function restoreStoredUsageSnapshot() {
  if (sharedSnapshot || typeof window === "undefined") return sharedSnapshot;
  try {
    const raw = window.localStorage.getItem(USAGE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!validUsageSnapshot(parsed)) return null;
    sharedSnapshot = parsed;
    return parsed;
  } catch {
    return null;
  }
}

async function performSharedPlanUsageLoad(force: boolean) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), force ? 10_000 : 9_000);
  try {
    const res = await fetch(force ? "/api/plan-usage?refresh=1" : "/api/plan-usage", {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return;
    const nextSnapshot = (await res.json()) as unknown;
    if (!validUsageSnapshot(nextSnapshot)) return;
    publishUsageSnapshot(nextSnapshot);
    if (nextSnapshot.refreshing) {
      window.setTimeout(() => void loadSharedPlanUsage(false), 1_500);
    }
  } catch {
    // A transient quota endpoint failure must never blank a previously valid UI.
  } finally {
    window.clearTimeout(timer);
  }
}

async function loadSharedPlanUsage(force = false) {
  if (sharedInflight) {
    if (!force) return sharedInflight;
    await sharedInflight;
  }
  const request = performSharedPlanUsageLoad(force).finally(() => {
    if (sharedInflight === request) sharedInflight = null;
  });
  sharedInflight = request;
  return request;
}

export function usePlanUsageSnapshot(enabled = true) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(sharedSnapshot);

  useEffect(() => {
    if (!enabled) return;
    const restored = restoreStoredUsageSnapshot();
    if (restored) setSnapshot(restored);
    sharedListeners.add(setSnapshot);
    void loadSharedPlanUsage(false);

    if (!sharedTimer) sharedTimer = setInterval(() => void loadSharedPlanUsage(false), USAGE_POLL_MS);
    const refreshOnFocus = () => {
      const age = sharedSnapshot ? Date.now() - Date.parse(sharedSnapshot.fetchedAt) : Number.POSITIVE_INFINITY;
      if (age > 45_000) void loadSharedPlanUsage(false);
    };
    window.addEventListener("focus", refreshOnFocus);

    return () => {
      sharedListeners.delete(setSnapshot);
      window.removeEventListener("focus", refreshOnFocus);
      if (sharedListeners.size === 0 && sharedTimer) {
        clearInterval(sharedTimer);
        sharedTimer = null;
      }
    };
  }, [enabled]);

  const refresh = useCallback(async (force = false) => {
    await loadSharedPlanUsage(force);
  }, []);

  return { snapshot, refresh };
}

export function usageForSelectedProvider(
  snapshot: UsageSnapshot | null,
  selection?: string | UsageSelection | null,
) {
  if (!snapshot) return null;
  return matchUsageProvider(snapshot.providers, selection);
}
