"use client";

import { Brain, ChevronRight } from "lucide-react";
import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import type { TimelineReasoningItem } from "@/lib/timeline/reducer";

const activityRowClass =
  "inline-flex max-w-full cursor-pointer items-center gap-1 appearance-none rounded-none border-0 bg-transparent p-0 text-left text-[11px] font-light text-muted-foreground/70 shadow-none ring-0 outline-none transition-colors hover:bg-transparent hover:text-muted-foreground focus-visible:ring-0";

function formatDuration(ms?: number): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10 && !Number.isInteger(s)) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}

interface ReasoningBlockProps {
  reasoning: TimelineReasoningItem;
  embedded?: boolean;
}

export const ReasoningBlock = memo(function ReasoningBlock({
  reasoning,
  embedded = false,
}: ReasoningBlockProps) {
  const [expanded, setExpanded] = useState(!reasoning.done);

  const durationLabel = formatDuration(reasoning.durationMs);
  const title = reasoning.done
    ? durationLabel
      ? `Thought for ${durationLabel}`
      : "Thought"
    : durationLabel
      ? `Thinking for ${durationLabel}`
      : "Thinking";

  return (
    <div className={cn("flex w-full min-w-0 flex-col", embedded ? "my-0" : "my-0.5")}>
      <div className="flex w-full min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={title}
          onClick={() => setExpanded((value) => !value)}
          className={cn(activityRowClass, "min-w-0 flex-1")}
        >
          <Brain className="size-3 shrink-0 opacity-70" />
          <span className="truncate">{title}</span>
          {!reasoning.done && !durationLabel ? (
            <span className="shrink-0 text-muted-foreground/50">…</span>
          ) : null}
        </button>
      </div>
      {expanded ? (
        <div className="mt-0.5 max-h-48 overflow-y-auto whitespace-pre-wrap pl-4 text-[11px] font-light italic leading-relaxed text-muted-foreground/70">
          {reasoning.text || "…"}
        </div>
      ) : null}
    </div>
  );
});

ReasoningBlock.displayName = "ReasoningBlock";