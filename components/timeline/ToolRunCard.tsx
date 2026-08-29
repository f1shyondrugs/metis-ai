"use client";

import {
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  Code2,
  ExternalLink,
  FilePenLine,
  FileSearch,
  Globe2,
  LoaderCircle,
  MemoryStick,
  Palette,
  PlugZap,
  TerminalSquare,
  Trash2,
  Wrench,
} from "lucide-react";
import { memo, useState, type ComponentType } from "react";
import { cn } from "@/lib/utils";
import type { TimelineToolItem } from "@/lib/timeline/reducer";

function formatDuration(startedAt: string, completedAt?: string): string | null {
  if (!completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 10 && !Number.isInteger(s) ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

function inferredKind(tool: TimelineToolItem) {
  if (tool.toolKind) return tool.toolKind;
  const name = tool.name.toLowerCase();
  if (/canvas/.test(name)) return "canvas";
  if (/plan|todo/.test(name)) return "plan";
  if (/browser|web_|navigate|search_web/.test(name)) return "browser";
  if (/subagent|delegate/.test(name)) return "subagent";
  if (/memory|context_/.test(name)) return "memory";
  if (/read|list|find|search|inspect/.test(name)) return "read";
  if (/edit|write|create|delete|remove|patch/.test(name)) return "edit";
  if (/command|shell|terminal|exec/.test(name)) return "shell";
  if (/mcp|gateway|capability/.test(name)) return "mcp";
  return "other";
}

function iconFor(kind: string, name: string): ComponentType<{ className?: string }> {
  if (/delete|remove|unlink/i.test(name) && kind === "edit") return Trash2;
  if (kind === "canvas") return Palette;
  if (kind === "plan") return ClipboardList;
  if (kind === "browser") return Globe2;
  if (kind === "subagent") return Bot;
  if (kind === "memory") return MemoryStick;
  if (kind === "read") return FileSearch;
  if (kind === "edit") return FilePenLine;
  if (kind === "shell" || kind === "terminal") return TerminalSquare;
  if (kind === "mcp") return PlugZap;
  return Wrench;
}

function labelFor(tool: TimelineToolItem) {
  return tool.summary?.trim() || tool.name.replaceAll("_", " ");
}

function formatPayload(value: unknown) {
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

interface ToolRunCardProps {
  tool: TimelineToolItem;
  nested?: boolean;
  onOpenDiff?: () => void;
  onOpenSubagent?: () => void;
  onOpenWorkspace?: () => void;
  onOpenRaw?: () => void;
}

export const ToolRunCard = memo(function ToolRunCard({
  tool,
  nested = false,
  onOpenDiff,
  onOpenSubagent,
  onOpenWorkspace,
  onOpenRaw,
}: ToolRunCardProps) {
  const [expanded, setExpanded] = useState(false);
  const running = tool.status === "in_progress";
  const failed = tool.status === "failed" || tool.status === "declined";
  const kind = inferredKind(tool);
  const duration = formatDuration(tool.startedAt, tool.completedAt);
  const Icon = iconFor(kind, tool.name);
  const clickable = kind === "edit" && Boolean(tool.output);
  const subagentClickable = kind === "subagent";
  const workspaceClickable = ["plan", "canvas", "browser"].includes(kind);
  const label = labelFor(tool);

  return (
    <div className={cn("w-full min-w-0", nested ? "pl-4" : "")} style={{ overflowAnchor: "none" }}>
      <div className={cn(
        "group flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 transition-colors",
        running && "bg-muted/25",
        failed && "bg-rose-500/[0.045]",
        !running && !failed && "hover:bg-muted/25",
      )}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          aria-expanded={expanded}
          onClick={() => {
            if (subagentClickable && onOpenSubagent) return onOpenSubagent();
            setExpanded((value) => !value);
          }}
        >
          {running ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary/75" /> : failed ? <CircleAlert className="size-3.5 shrink-0 text-rose-400/85" /> : <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400/70" />}
          <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/55", failed && "bg-rose-500/10 text-rose-300")}><Icon className="size-3" /></span>
          <span className={cn("min-w-0 flex-1 truncate capitalize", failed ? "text-rose-300/90" : "text-foreground/78")}>{label}</span>
          {duration ? <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/45">{duration}</span> : null}
          {!running ? <ChevronRight className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} /> : null}
        </button>
        {clickable && onOpenDiff ? <button type="button" className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/45 opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100" title="Open diff" aria-label="Open diff" onClick={(event) => { event.stopPropagation(); onOpenDiff(); }}><FilePenLine className="size-3" /></button> : null}
        {workspaceClickable && onOpenWorkspace ? <button type="button" className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/45 opacity-70 transition hover:bg-muted hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100" title="Open workspace" aria-label="Open workspace" onClick={(event) => { event.stopPropagation(); onOpenWorkspace(); }}><ExternalLink className="size-3" /></button> : null}
        {onOpenRaw ? <button type="button" className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/40 opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100" title="Raw event" aria-label="Raw event" onClick={(event) => { event.stopPropagation(); onOpenRaw(); }}><Code2 className="size-3" /></button> : null}
      </div>
      {expanded ? (
        <div className="ml-5 mt-1 max-h-80 space-y-2 overflow-auto rounded-xl border border-border/35 bg-background/45 p-2.5 text-[11px] leading-4 text-muted-foreground">
          {tool.input !== undefined ? <section><p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">Input</p><pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-foreground/70">{formatPayload(tool.input)}</pre></section> : null}
          {tool.output !== undefined ? <section><p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/55">Result</p><pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-foreground/70">{formatPayload(tool.output)}</pre></section> : null}
          {tool.error ? <section><p className="mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-rose-400/70">Error</p><pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-rose-300/85">{tool.error}</pre></section> : null}
          {tool.input === undefined && tool.output === undefined && !tool.error ? <span className="text-muted-foreground/55">No details recorded.</span> : null}
        </div>
      ) : null}
    </div>
  );
});

ToolRunCard.displayName = "ToolRunCard";
