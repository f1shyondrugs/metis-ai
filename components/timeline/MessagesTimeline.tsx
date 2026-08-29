"use client";

import { memo } from "react";
import { CircleHelp, MessageSquareText } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolRunCard } from "./ToolRunCard";
import { ReasoningBlock } from "./ReasoningBlock";
import { ContextMeter } from "./ContextMeter";
import type { TimelineItem, TimelineToolItem } from "@/lib/timeline/reducer";

interface MessagesTimelineProps {
  items: TimelineItem[];
  contextUsed?: number;
  contextTotal?: number;
  contextEffectiveTotal?: number;
  contextMode?: "normal" | "limited";
  onOpenDiff?: (tool: TimelineToolItem) => void;
  onOpenSubagent?: (tool: TimelineToolItem) => void;
  onOpenWorkspace?: (tool: TimelineToolItem) => void;
  onOpenRaw?: (tool: TimelineToolItem) => void;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  items,
  contextUsed,
  contextTotal,
  contextEffectiveTotal,
  contextMode = "normal",
  onOpenDiff,
  onOpenSubagent,
  onOpenWorkspace,
  onOpenRaw,
}: MessagesTimelineProps) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5">
      {contextUsed !== undefined && contextTotal !== undefined ? (
        <div className="rounded-xl border border-border/35 bg-muted/20 px-3 py-2">
          <ContextMeter usedTokens={contextUsed} totalTokens={contextTotal} effectiveTotalTokens={contextEffectiveTotal} mode={contextMode} compact />
        </div>
      ) : null}

      <div className="min-w-0 space-y-0.5">
        {items.map((item, index) => {
          if (item.kind === "turn-boundary") {
            if (!item.completedAt) return null;
            return (
              <div key={`turn-${item.turnId}-${index}`} className="my-1 flex items-center gap-2 px-1 text-[10px] text-muted-foreground/45">
                <span className="h-px flex-1 bg-border/30" />
                <span>{item.stopReason === "failed" ? "Run failed" : "Run complete"}</span>
                <span className="h-px flex-1 bg-border/30" />
              </div>
            );
          }

          if (item.kind === "tool") {
            return (
              <ToolRunCard
                key={`tool-${item.itemId}-${index}`}
                tool={item}
                onOpenDiff={() => onOpenDiff?.(item)}
                onOpenSubagent={() => onOpenSubagent?.(item)}
                onOpenWorkspace={() => onOpenWorkspace?.(item)}
                onOpenRaw={() => onOpenRaw?.(item)}
              />
            );
          }

          if (item.kind === "reasoning") return <ReasoningBlock key={`reasoning-${item.itemId}-${index}`} reasoning={item} />;

          if (item.kind === "request") {
            const resolved = Boolean(item.decision || item.respondedAt);
            return (
              <div key={`request-${item.requestId}-${index}`} className="my-1.5 flex items-start gap-2.5 rounded-xl border border-border/45 bg-card/45 px-3 py-2.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-400/[0.08] text-amber-300"><CircleHelp className="size-3.5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><p className="truncate text-xs font-semibold text-foreground/85">{item.title || item.requestKind.replaceAll("_", " ")}</p>{resolved ? <span className="rounded-full bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-300/80">answered</span> : <span className="rounded-full bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-300/80">input needed</span>}</div>
                  {item.detail ? <p className="mt-1 text-[11px] leading-4 text-muted-foreground/75">{item.detail}</p> : null}
                  {item.options?.length ? <div className="mt-2 flex flex-wrap gap-1.5">{item.options.map((option, optionIndex) => <span key={option.id || optionIndex} className="rounded-lg border border-border/45 bg-background/50 px-2 py-1 text-[10px] text-foreground/75">{option.label}</span>)}</div> : null}
                </div>
              </div>
            );
          }

          if (item.kind === "content") {
            const reasoning = item.contentKind === "reasoning_text" || item.contentKind === "reasoning_summary_text";
            if (reasoning) {
              return (
                <div key={`content-${item.itemId}-${index}`} className="my-0.5 flex min-w-0 items-start gap-1.5 px-1.5 py-1 text-[11px] leading-4 text-muted-foreground/65">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-violet-300/45" />
                  <span className="min-w-0 whitespace-pre-wrap italic">{item.text}</span>
                </div>
              );
            }
            if (item.contentKind === "command_output") {
              return <pre key={`content-${item.itemId}-${index}`} className="my-1 max-h-64 overflow-auto rounded-xl border border-border/35 bg-black/15 p-2.5 font-mono text-[10px] leading-4 text-foreground/70">{item.text}</pre>;
            }
            return (
              <div key={`content-${item.itemId}-${index}`} className={cn("my-1 flex min-w-0 items-start gap-2 text-[12px] leading-5 text-foreground/82", item.contentKind === "unknown" && "text-muted-foreground") }>
                <MessageSquareText className="mt-1 size-3 shrink-0 text-muted-foreground/45" />
                <span className="min-w-0 whitespace-pre-wrap">{item.text}</span>
              </div>
            );
          }
          return null;
        })}
        {items.length === 0 ? <div className="flex h-24 items-center justify-center text-xs text-muted-foreground/45">No runtime activity yet</div> : null}
      </div>
    </div>
  );
});

MessagesTimeline.displayName = "MessagesTimeline";
