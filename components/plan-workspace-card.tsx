"use client";

import {
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  ExternalLink,
  GitBranch,
  Play,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";

export type PlanWorkspaceCardProps = {
  title: string;
  content: string;
  workspaceLink?: string;
  onOpen?: () => void;
  onBuild?: () => void;
  onBuildWithAgents?: () => void;
  showMultiAgent?: boolean;
  buildDisabled?: boolean;
  compact?: boolean;
};

function planStats(content: string) {
  const checks = [...content.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+/gm)];
  const completed = checks.filter((match) => /x/i.test(match[1] || "")).length;
  const steps = content
    .split("\n")
    .filter((line) => /^\s*(?:\d+[.)]|[-*])\s+\S/.test(line) && !/^\s*[-*]\s+\[[ xX]\]/.test(line)).length;
  return {
    total: checks.length || steps,
    completed: checks.length ? completed : 0,
    checklist: checks.length > 0,
  };
}

export function PlanWorkspaceCard({
  title,
  content,
  workspaceLink,
  onOpen,
  onBuild,
  onBuildWithAgents,
  showMultiAgent = false,
  buildDisabled = false,
  compact = false,
}: PlanWorkspaceCardProps) {
  const [copied, setCopied] = useState(false);
  const stats = useMemo(() => planStats(content), [content]);
  const progress = stats.checklist && stats.total ? Math.round((stats.completed / stats.total) * 100) : null;

  async function copyRawContent() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      toast.success("Plan copied");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Could not copy plan");
    }
  }

  return (
    <section className="my-3 w-full overflow-hidden rounded-2xl border border-border/55 bg-card/55 shadow-sm shadow-black/5">
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-blue-400/15 bg-blue-400/[0.08] text-blue-300">
          <ClipboardList className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.13em] text-blue-300/85">Plan</span>
            {stats.total > 0 ? (
              <span className="text-[10px] tabular-nums text-muted-foreground/65">
                {stats.checklist ? `${stats.completed}/${stats.total} tasks` : `${stats.total} steps`}
              </span>
            ) : null}
          </div>
          <h3 className="mt-0.5 truncate text-sm font-semibold tracking-tight text-foreground" title={title}>{title}</h3>
          {progress !== null ? (
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1.5 min-w-20 flex-1 overflow-hidden rounded-full bg-muted/70">
                <div className="h-full rounded-full bg-blue-400/80 transition-[width]" style={{ width: `${progress}%` }} />
              </div>
              <span className="text-[10px] tabular-nums text-muted-foreground/60">{progress}%</span>
            </div>
          ) : null}
        </div>
        {onOpen ? (
          <button type="button" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground" aria-label="Open plan workspace" title="Open plan" onClick={onOpen}>
            <ExternalLink className="size-3.5" />
          </button>
        ) : null}
      </div>

      {!compact ? (
        <div className="border-y border-border/35 bg-background/35 px-4 py-3">
          <div className="max-h-52 overflow-hidden text-[13px] leading-5 text-foreground/85 [&_.markdown-body]:m-0 [&_.markdown-body_h1]:mt-0 [&_.markdown-body_h2]:mt-2 [&_.markdown-body_p]:my-1.5 [&_.markdown-body_ul]:my-1.5 [&_.markdown-body_ol]:my-1.5">
            {content ? <Markdown content={content} /> : <p className="text-muted-foreground">No plan details yet.</p>}
          </div>
        </div>
      ) : (
        <div className="border-y border-border/35 bg-background/30 px-4 py-2.5 text-xs text-muted-foreground">
          {content.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "").slice(0, 150) || "Open the plan to view its details."}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2.5">
        <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground" onClick={() => void copyRawContent()}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
        {workspaceLink ? (
          <span className="hidden min-w-0 flex-1 truncate px-1 text-[10px] text-muted-foreground/45 sm:block">{workspaceLink}</span>
        ) : <span className="flex-1" />}
        {onOpen ? (
          <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium text-foreground/85 transition-colors hover:bg-muted/70" onClick={onOpen}>
            <CheckCircle2 className="size-3.5" /> Open
          </button>
        ) : null}
        {showMultiAgent && onBuildWithAgents ? (
          <button type="button" disabled={buildDisabled} className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border/60 bg-background/60 px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-45" title="Build independent workstreams in parallel" onClick={onBuildWithAgents}>
            <GitBranch className="size-3.5" /> {buildDisabled ? "Running" : "Parallel"}
          </button>
        ) : null}
        {onBuild ? (
          <button type="button" disabled={buildDisabled} className={cn("inline-flex h-7 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-90", "disabled:cursor-not-allowed disabled:opacity-45")} onClick={onBuild}>
            <Play className="size-3.5 fill-current" /> {buildDisabled ? "Running" : "Build"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
