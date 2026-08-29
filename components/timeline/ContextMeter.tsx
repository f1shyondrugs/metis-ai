"use client";

import { memo } from "react";
import { cn } from "@/lib/utils";
import {
  contextPressure,
  effectiveContextBudget,
  type ContextMode,
  CONTEXT_COMPACT_RATIO,
  CONTEXT_CRITICAL_RATIO,
} from "@/lib/context-window";

interface ContextMeterProps {
  usedTokens: number;
  totalTokens?: number;
  effectiveTotalTokens?: number;
  mode?: ContextMode;
  showLabel?: boolean;
  compact?: boolean;
}

export const ContextMeter = memo(function ContextMeter({
  usedTokens,
  totalTokens,
  effectiveTotalTokens,
  mode = "normal",
  showLabel = true,
  compact = false,
}: ContextMeterProps) {
  const total = effectiveTotalTokens ?? totalTokens ?? 0;
  const budget = total > 0 ? effectiveContextBudget(total, mode) : 0;
  const pressure = contextPressure(usedTokens, budget);

  if (!total || budget <= 0) {
    return (
      <div className={cn("flex items-center gap-2", compact && "text-xs")}>
        <span className="text-muted-foreground/50">Context: unknown</span>
      </div>
    );
  }

  const ratio = pressure.ratio;
  const percent = Math.min(100, Math.round(ratio * 100));

  let trackColor = "bg-emerald-500/80";
  let labelColor = "text-emerald-400";
  if (pressure.critical) {
    trackColor = "bg-rose-500/80";
    labelColor = "text-rose-400";
  } else if (pressure.compactRecommended) {
    trackColor = "bg-amber-500/80";
    labelColor = "text-amber-400";
  }

  const ringSize = compact ? 32 : 40;
  const strokeWidth = compact ? 3 : 4;
  const radius = (ringSize - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(1, ratio));

  return (
    <div className={cn("flex items-center gap-2", compact && "gap-1.5")}>
      <div className="relative flex items-center justify-center" style={{ width: ringSize, height: ringSize }}>
        <svg className="transform -rotate-90" width={ringSize} height={ringSize}>
          <circle
            className="text-muted-foreground/10"
            strokeWidth={strokeWidth}
            stroke="currentColor"
            fill="none"
            r={radius}
            cx={ringSize / 2}
            cy={ringSize / 2}
          />
          <circle
            className={cn("transition-all duration-300", trackColor)}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            stroke="currentColor"
            fill="none"
            r={radius}
            cx={ringSize / 2}
            cy={ringSize / 2}
          />
        </svg>
        <span className={cn("absolute text-[10px] font-medium tabular-nums", labelColor)}>
          {percent}%
        </span>
      </div>
      {showLabel && (
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1 text-[11px]">
            <span className="font-medium text-foreground">{formatTokens(usedTokens)}</span>
            <span className="text-muted-foreground/50">/</span>
            <span className="text-muted-foreground">{formatTokens(budget)}</span>
            {pressure.overflow && (
              <span className="text-rose-400/80 text-[10px] font-medium">overflow</span>
            )}
          </div>
          <div className="h-1 w-full bg-muted/50 rounded-full overflow-hidden">
            <div
              className={cn("h-full transition-all duration-300 rounded-full", trackColor)}
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </div>
          {compact ? null : (
            <p className="mt-0.5 text-[10px] text-muted-foreground/60">
              {pressure.compactRecommended && !pressure.critical
                ? `Compact recommended at ${Math.round(CONTEXT_COMPACT_RATIO * 100)}%`
                : pressure.critical
                ? `Critical at ${Math.round(CONTEXT_CRITICAL_RATIO * 100)}%`
                : "Within normal range"}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

ContextMeter.displayName = "ContextMeter";