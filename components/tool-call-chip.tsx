"use client";

import {
  BookOpen,
  Bot,
  Brain,
  Cable,
  CalendarClock,
  ChevronRight,
  Code2,
  FilePenLine,
  FolderOpen,
  Globe2,
  ListTodo,
  LoaderCircle,
  ExternalLink,
  Search,
  Shrink,
  StickyNote,
  Terminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import { AutomationCard } from "@/components/automation-card";
import { PlanWorkspaceCard } from "@/components/plan-workspace-card";
import { planLooksParallelizable } from "@/lib/modes";
import { CanvasWorkspaceCard } from "@/components/canvas-workspace-card";

import {
  compactFileDiff,
  enrichToolDisplay,
  isToolRunning,
  planFromToolPayload,
  todosFromToolPayload,
  toolCallHeadline,
  activityGroupLabel,
 memoryCardFromPayload,
 toolGroupLabel,
  truncateToolText,
  type ToolActionIcon,
} from "@/lib/tool-call-display";
import { looksLikeTranscriptDump } from "@/lib/agent-transcript";

import { parseAutomationCard } from "@/lib/tool-kind";
import { ThinkingBlock, activityRowClass } from "@/components/thinking-block";

export type ToolCallData = {
  id: string;
  name: string;
  status: string;
  detail?: string;
  kind?: "plan" | "edit" | "read" | "shell" | "subagent" | "mcp" | "canvas" | "note" | "todo" | "browser" | "memory" | "automation" | "compaction" | "other";
  source?: "mcp" | "native" | "browser";
  path?: string;
  diff?: { before?: string; after?: string; additions?: number; deletions?: number };
  input?: string;
  result?: string;
  todos?: Array<{ id?: string; content: string; status?: string }>;
  subagent?: {
    agentId?: string;
    chatId?: string;
    title?: string;
    mode?: string;
    model?: string;
    prompt?: string;
    messages?: Array<{ role: string; text: string; timestamp?: string }>;
    tools?: ToolCallData[];
  };
};

type ToolCallProps = ToolCallData & {
  onOpenDiff?: () => void;
  onOpenSubagent?: () => void;
  onOpenWorkspace?: () => void;
  onBuildPlan?: (plan: { title: string; content: string; workspaceLink?: string }, options?: { multiAgent?: boolean }) => void;
  buildDisabled?: boolean;
  onOpenRaw?: () => void;
  autoExpand?: boolean;
  locked?: boolean;
  nested?: boolean;
  hostnames?: Record<string, string>;
};

const ACTION_ICONS: Record<ToolActionIcon, typeof BookOpen> = {
  folder: FolderOpen,
  search: Search,
  read: BookOpen,
  edit: FilePenLine,
  shell: Terminal,
  mcp: Wrench,
  browser: Globe2,
  subagent: Bot,
  compress: Shrink,
  other: Globe2,
};

function formatStructuredValue(value: unknown, indent = 0): string {
  if (value === null) return "null";
  if (typeof value !== "object") return String(value);

  const padding = " ".repeat(indent);
  if (Array.isArray(value)) {
    return value
      .map((item, index) => {
        const formatted = formatStructuredValue(item, indent + 2);
        return typeof item === "object" && item !== null
          ? `${padding}${index}:\n${formatted}`
          : `${padding}${index}: ${formatted}`;
      })
      .join("\n");
  }

  return Object.entries(value)
    .map(([key, item]) => {
      const formatted = formatStructuredValue(item, indent + 2);
      return typeof item === "object" && item !== null
        ? `${padding}${key}:\n${formatted}`
        : `${padding}${key}: ${formatted}`;
    })
    .join("\n");
}

function formatToolOutput(value?: string): string {
  if (!value) return "";
  if (looksLikeTranscriptDump(value)) return "";
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "status" in parsed &&
      (parsed as { status?: unknown }).status === "success" &&
      "value" in parsed &&
      Object.keys((parsed as { value?: unknown }).value ?? {}).length === 0
    ) {
      return "";
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { plan?: unknown }).plan === "string"
    ) {
      return (parsed as { plan: string }).plan;
    }
    const formatted = typeof parsed === "string" ? parsed : formatStructuredValue(parsed);
    if (looksLikeTranscriptDump(formatted)) return "";
    return truncateToolText(formatted);
  } catch {
    // Tool output is often plain text.
  }
  return truncateToolText(value);
}

function displayedDiffStats(diff?: ToolCallData["diff"], input?: string) {
  if (!diff && !input) return null;
  if (diff && (typeof diff.additions === "number" || typeof diff.deletions === "number")) {
    if ((diff.additions ?? 0) !== 0 || (diff.deletions ?? 0) !== 0 || diff.before === diff.after) {
      return { additions: diff.additions ?? 0, deletions: diff.deletions ?? 0 };
    }
  }
  try {
    const parsed = input ? JSON.parse(input) as { edits?: Array<{ oldText?: unknown; newText?: unknown }>; content?: unknown } : null;
    if (Array.isArray(parsed?.edits)) {
      return parsed.edits.reduce(
        (stats, edit) => ({
          additions: stats.additions + (typeof edit.newText === "string" && edit.newText ? edit.newText.split("\n").length : 0),
          deletions: stats.deletions + (typeof edit.oldText === "string" && edit.oldText ? edit.oldText.split("\n").length : 0),
        }),
        { additions: 0, deletions: 0 },
      );
    }
    if (typeof parsed?.content === "string") {
      return { additions: parsed.content ? parsed.content.split("\n").length : 0, deletions: 0 };
    }
  } catch {
    // Input may be streamed plain text.
  }
  const before = (diff?.before ?? "").split("\n");
  const after = (diff?.after ?? "").split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return {
    additions: Math.max(0, afterEnd - start),
    deletions: Math.max(0, beforeEnd - start),
  };
}

function canvasInfo(input?: string, result?: string, detail?: string) {
  const sources = [input, result, detail].filter(Boolean) as string[];
  for (const source of sources) {
    try {
      const parsed = JSON.parse(source) as Record<string, unknown>;
      const value = parsed.value && typeof parsed.value === "object"
        ? parsed.value as Record<string, unknown>
        : {};
      const content = [parsed.canvas, parsed.content, value.canvas, value.content]
        .find((candidate): candidate is string => typeof candidate === "string");
      if (content !== undefined) {
        const title = [parsed.title, parsed.name, value.title, value.name]
          .find((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate.trim()));
        return {
          title: title?.trim() || "Canvas",
          content: content.trim(),
          workspaceLink: typeof parsed.workspaceLink === "string" ? parsed.workspaceLink : undefined,
        };
      }
    } catch {
      if (source.trim() && !source.trim().startsWith("{")) {
        return { title: "Canvas", content: source.trim() };
      }
    }
  }
  return null;
}

function noteInfo(input?: string, result?: string, detail?: string) {
  for (const source of [result, input, detail].filter(Boolean) as string[]) {
    try {
      const parsed = JSON.parse(source) as Record<string, unknown>;
      const value = parsed.value && typeof parsed.value === "object"
        ? parsed.value as Record<string, unknown>
        : {};
      const note = [parsed.note, value.note].find(
        (candidate): candidate is Record<string, unknown> =>
          Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate),
      );
      if (!note || typeof note.id !== "string") continue;
      return {
        id: note.id,
        title: typeof note.title === "string" && note.title.trim() ? note.title.trim() : "Untitled note",
        content: typeof note.content === "string" ? note.content : "",
      };
    } catch {
      // Tool output may still be streaming or plain text.
    }
  }
  return null;
}

function toolReactKey(tool: ToolCallData, index: number): string {
  const id = tool.id?.trim();
  if (id) return `tool-${tool.kind || "other"}-${id}`;
  const fingerprint = [tool.kind, tool.name, tool.path, tool.input, tool.result]
    .filter(Boolean)
    .join(":")
    .slice(0, 160);
  return `tool-${fingerprint || "unknown"}-${index}`;
}

function automationInfo(name: string, input?: string, result?: string, detail?: string) {
  return parseAutomationCard(name, result, input, detail);
}

function isAutomationCardTool(tool: ToolCallData) {
  if (["running", "in_progress", "pending", "started", "executing", "queued"].includes(tool.status.toLowerCase())) {
    return false;
  }
  return Boolean(automationInfo(tool.name, tool.input, tool.result, tool.detail));
}

function mcpDisplayInfo(name: string, input?: string, detail?: string) {
  const source = input || detail;
  let values: Record<string, unknown> = {};
  try {
    const parsed = source ? JSON.parse(source) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      values = parsed as Record<string, unknown>;
    }
  } catch {
    // MCP arguments may be plain text.
  }
  const nested = values.arguments && typeof values.arguments === "object"
    ? values.arguments as Record<string, unknown>
    : {};
  const server = typeof values.server === "string" ? values.server : undefined;
  const tool = typeof values.tool === "string"
    ? values.tool
    : typeof values.toolName === "string"
      ? values.toolName
      : undefined;
  const nestedServer = typeof nested.server === "string" ? nested.server : undefined;
  const nestedTool = typeof nested.tool === "string"
    ? nested.tool
    : typeof nested.toolName === "string"
      ? nested.toolName
      : undefined;
  const action = [nestedServer || server, nestedTool || tool].filter(Boolean).join(" · ") || name.replaceAll("_", " ");
  const description = [
    values.description,
    values.command,
    values.query,
    values.path,
    nested.description,
    nested.command,
    nested.query,
    nested.path,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return {
    label: action,
    detail: description?.replace(/\s+/g, " ").trim(),
  };
}

function toolDisplayInfo(kind: ToolCallData["kind"], name: string, input?: string, detail?: string, path?: string) {
  let values: Record<string, unknown> = {};
  try {
    const parsed = input ? JSON.parse(input) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values = parsed as Record<string, unknown>;
  } catch {
    // Keep the compact fallback for streamed or plain-text arguments.
  }
  const command = [values.command, values.cmd, values.script]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  const inputPath = path || [values.path, values.file, values.filePath, values.filename]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  const readableName = name
    .replaceAll("_", " ")
    .replace(/^(shell|read|edit|write)\s*/i, "")
    .trim();
  const primary = kind === "shell"
    ? command || readableName
    : kind === "read" || kind === "edit"
      ? inputPath || readableName
      : readableName;
  const output = detail?.replace(/\s+/g, " ").trim();
  const extra = command && primary !== command ? command : output;
  return {
    label: primary || kind || name.replaceAll("_", " "),
    detail: extra && !isSameCompactText(primary, extra) ? extra : undefined,
  };
}

function isSameCompactText(left?: string, right?: string) {
  if (!left || !right) return false;
  const a = left.replace(/\s+/g, " ").trim().toLowerCase();
  const b = right.replace(/\s+/g, " ").trim().replace(/…$/u, "").trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export const ToolCallChip = memo(function ToolCallChip({
  name,
  status,
  detail,
  kind,
  path,
  diff,
  input,
  result,
  subagent,
  onOpenDiff,
  onOpenSubagent,
  onOpenWorkspace,
  onBuildPlan,
  buildDisabled,
  onOpenRaw,
  autoExpand = false,
  locked = false,
  nested = false,
  todos,
  hostnames,
  source,
}: ToolCallProps) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const running = isToolRunning(status);
  const expanded = locked ? autoExpand : userOpen ?? autoExpand;
  const display = enrichToolDisplay({ name, input, result, kind });
  const todoItems = todos?.length ? todos : display.todos;
  const resolvedKind = display.kind;
  const resolvedName = display.name || name;
  const deleteTool = /(^|[._:/-])(delete|remove|unlink)(?=[._:/-]|$)/i.test(resolvedName);
  const headline = toolCallHeadline({ name: resolvedName, kind: resolvedKind, input, detail, path, hostnames });
 const sourceLabel = source === "mcp" && resolvedKind !== "mcp" ? "Metis" : source === "native" ? "CLI" : null;
  const Icon = deleteTool && (resolvedKind === "edit" || headline.icon === "edit")
    ? Trash2
    : ACTION_ICONS[headline.icon];
  const clickable = resolvedKind === "edit" && Boolean(diff || path);
  const subagentClickable = resolvedKind === "subagent";
  const workspaceClickable = resolvedKind === "plan" || resolvedKind === "canvas" || resolvedKind === "browser";
  if (todoItems?.length) {
    const completed = todoItems.filter((todo) => /^(completed|done)$/i.test(todo.status || "")).length;
    const percent = Math.round((completed / todoItems.length) * 100);
    return (
      <section className="my-2.5 w-full overflow-hidden rounded-xl border border-border/45 bg-card/40">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-blue-400/[0.08] text-blue-300"><ListTodo className="size-3.5" /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-semibold text-foreground/85">Tasks</span>
              <span className="text-[10px] tabular-nums text-muted-foreground/60">{completed}/{todoItems.length} · {percent}%</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted/70"><div className="h-full rounded-full bg-blue-400/75 transition-[width]" style={{ width: `${percent}%` }} /></div>
          </div>
          {onOpenRaw ? <button type="button" className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/45 hover:bg-muted hover:text-foreground" aria-label="Show raw tool information" onClick={onOpenRaw}><Code2 className="size-3" /></button> : null}
        </div>
        <div className="border-t border-border/30 px-3 py-2">
          <div className="space-y-1.5">
            {todoItems.map((todo, index) => {
              const done = /^(completed|done)$/i.test(todo.status || "");
              const active = /^(in_progress|running)$/i.test(todo.status || "");
              return (
                <div key={todo.id ?? `${todo.content}-${index}`} className="flex min-w-0 items-start gap-2 text-xs">
                  <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px] transition-colors", done ? "border-emerald-400/45 bg-emerald-400/10 text-emerald-300" : active ? "border-blue-400/55 bg-blue-400/10 text-blue-300" : "border-border/65 text-transparent")}>{done ? "✓" : active ? "•" : "·"}</span>
                  <span className={cn("min-w-0 flex-1 leading-4", done ? "text-muted-foreground/60 line-through" : active ? "font-medium text-foreground/90" : "text-foreground/72")}>{todo.content}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    );
  }
  if (resolvedKind === "memory") {
    const memoryCard = memoryCardFromPayload(name, input || detail, result || detail);
    return (
      <div className="my-2 flex w-full items-start gap-2.5 rounded-xl border border-violet-400/15 bg-violet-400/[0.035] px-3 py-2.5 text-xs">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-400/10 text-violet-300"><Brain className="size-3.5" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-violet-300/75">Memory</p>
          <p className="mt-0.5 font-medium text-foreground/85">{memoryCard.title}</p>
          <p className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap leading-4 text-muted-foreground/75">{memoryCard.body}</p>
        </div>
      </div>
    );
  }
  const plan = resolvedKind === "plan" ? planFromToolPayload(input, result, detail) : null;
  const previewText = headline.preview;
  const automation = !running ? automationInfo(name, input, result, detail) : null;
  const diffStats = displayedDiffStats(diff, input);
  if (resolvedKind === "plan" && !running && plan) {
    return (
      <PlanWorkspaceCard
        title={plan.title}
        content={plan.content}
        workspaceLink={plan.workspaceLink}
        onOpen={onOpenWorkspace}
        onBuild={() => onBuildPlan?.(plan)}
        onBuildWithAgents={() => onBuildPlan?.(plan, { multiAgent: true })}
        showMultiAgent={planLooksParallelizable(plan.content)}
        buildDisabled={buildDisabled}
        compact
      />
    );
  }
  const canvas = resolvedKind === "canvas" && !running
    ? canvasInfo(input, result, detail)
    : null;
  if (canvas) {
    return (
      <CanvasWorkspaceCard
        title={canvas.title}
        content={canvas.content}
        workspaceLink={canvas.workspaceLink}
        onOpen={onOpenWorkspace}
      />
    );
  }
  const note = resolvedKind === "note" && !running ? noteInfo(input, result, detail) : null;
  if (note) {
    return (
      <section className="my-2.5 w-full rounded-lg border border-border/50 border-l-yellow-300/70 bg-muted/20 p-2.5">
        <div className="flex items-start gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-yellow-300/10 text-yellow-300">
            <StickyNote className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium uppercase tracking-wide text-yellow-300/80">Note ready</p>
            <a
              href={`#note-${note.id}`}
              className="block truncate text-[13px] font-medium text-foreground underline decoration-border underline-offset-2 hover:text-primary"
              onClick={(event) => {
                event.preventDefault();
                window.dispatchEvent(new CustomEvent("ai-chat:open-note", { detail: { id: note.id } }));
              }}
            >
              {note.title}
            </a>
            <p className="mt-0.5 max-h-20 overflow-hidden whitespace-pre-wrap text-xs text-muted-foreground">
              {note.content || "No note details available yet."}
            </p>
            <p className="mt-1 truncate text-[10px] text-muted-foreground/70">note://{note.id}</p>
          </div>
          <a
            href={`#note-${note.id}`}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Open note"
            title="Open note"
            onClick={(event) => {
              event.preventDefault();
              window.dispatchEvent(new CustomEvent("ai-chat:open-note", { detail: { id: note.id } }));
            }}
          >
            <ExternalLink className="size-3.5" />
          </a>
        </div>
        <div className="mt-2 flex justify-end">
          <a
            href={`#note-${note.id}`}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={(event) => {
              event.preventDefault();
              window.dispatchEvent(new CustomEvent("ai-chat:open-note", { detail: { id: note.id } }));
            }}
          >
            Open note
          </a>
        </div>
      </section>
    );
  }
  if (automation) {
    return (
      <AutomationCard
        actionLabel={automation.actionLabel}
        title={automation.title}
        prompt={automation.prompt}
        scheduleLabel={automation.scheduleLabel}
        automationLink={automation.automationLink}
        onOpen={() => {
          window.dispatchEvent(new CustomEvent("ai-chat:open-automations", { detail: { id: automation.id } }));
        }}
      />
    );
  }
  return (
    <div className={cn(nested ? "my-0" : "my-0.5", "w-full min-w-0")} style={{ overflowAnchor: "none" }}>
      <div className="group flex w-full min-w-0 items-center gap-1">
        <button
          type="button"
          className={cn(activityRowClass, "min-w-0 flex-1")}
          onClick={() => {
            if (subagentClickable && onOpenSubagent) {
              onOpenSubagent();
              return;
            }
            if (locked) return;
            setUserOpen((open) => open === null ? !expanded : !open);
          }}
        >
          {running ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin" />
          ) : nested ? null : (
            <ChevronRight className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} />
          )}
          <Icon className="size-3 shrink-0 opacity-70" />
          <span className={cn("truncate", deleteTool && "text-rose-400/80")}>{headline.title}{sourceLabel ? <span className="ml-1 text-[10px] uppercase tracking-wide opacity-50">{sourceLabel}</span> : null}</span>
          {previewText ? (
            <span className="hidden truncate text-muted-foreground/45 sm:inline">· {previewText}</span>
          ) : null}
          {kind === "subagent" && subagent?.model ? (
            <span className="shrink-0 text-[10px] text-muted-foreground/50">{subagent.model}</span>
          ) : null}
          {kind === "edit" && diffStats ? (
            <span className="shrink-0 text-[10px] text-muted-foreground/50">
              +{diffStats.additions} -{diffStats.deletions}
            </span>
          ) : null}
        </button>
        {clickable ? (
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
            aria-label="Open file diff"
            title="Open file diff"
            onClick={(event) => {
              event.stopPropagation();
              onOpenDiff?.();
            }}
          >
            <FilePenLine className="size-3" />
          </button>
        ) : null}
        {subagentClickable ? (
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded text-violet-300/80 opacity-100 transition-opacity hover:bg-muted hover:text-foreground"
            aria-label="Open subagent"
            title="Open subagent"
            onClick={(event) => {
              event.stopPropagation();
              onOpenSubagent?.();
            }}
          >
            <ExternalLink className="size-3" />
          </button>
        ) : null}
        {workspaceClickable ? (
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
            aria-label={`Open ${resolvedKind === "canvas" ? "canvas" : resolvedKind === "plan" ? "plan" : "browser"} in side panel`}
            title={`Open ${resolvedKind === "canvas" ? "canvas" : resolvedKind === "plan" ? "plan" : "browser"}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenWorkspace?.();
            }}
          >
            <ExternalLink className="size-3" />
          </button>
        ) : null}
        {onOpenRaw ? (
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
            aria-label="Show raw tool information"
            onClick={(event) => {
              event.stopPropagation();
              onOpenRaw();
            }}
          >
            <Code2 className="size-3" />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div className="my-1 min-w-0 max-h-72 max-w-full space-y-2 overflow-x-hidden overflow-y-auto pl-4 text-[11px] font-light leading-4 text-muted-foreground/80">
          {input ? (
            <section>
              <p className="mb-1 font-sans text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Request</p>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono">{formatToolOutput(input)}</pre>
            </section>
          ) : null}
          {kind === "edit" && diff && (diff.before !== undefined || diff.after !== undefined) ? (
            <section>
              <p className="mb-1 font-sans text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">File diff</p>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono">{compactFileDiff(diff.before, diff.after)}</pre>
            </section>
          ) : null}
          {result || detail ? (
            <section>
              <p className="mb-1 font-sans text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Response</p>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono">{formatToolOutput(result || detail)}</pre>
            </section>
          ) : null}
          {!input && !(kind === "edit" && diff) && !result && !detail ? "No output available yet." : null}
        </div>
      ) : null}
    </div>
  );
});

export function PlanToolCallCard({
  tool,
  onOpenWorkspace,
  onBuildPlan,
  buildDisabled,
  hostnames,
}: {
  tool: ToolCallData;
  onOpenWorkspace?: () => void;
  onBuildPlan?: (plan: { title: string; content: string; workspaceLink?: string }, options?: { multiAgent?: boolean }) => void;
  buildDisabled?: boolean;
  hostnames?: Record<string, string>;
}) {
 const plan = planFromToolPayload(tool.input, tool.result, tool.detail);
  if (!isToolRunning(tool.status) && plan) {
    return (
      <PlanWorkspaceCard
        title={plan.title}
        content={plan.content}
        workspaceLink={plan.workspaceLink}
        onOpen={onOpenWorkspace}
        onBuild={() => onBuildPlan?.(plan)}
        onBuildWithAgents={() => onBuildPlan?.(plan, { multiAgent: true })}
        showMultiAgent={planLooksParallelizable(plan.content)}
        buildDisabled={buildDisabled}
        compact
      />
    );
  }
  return (
    <ToolCallChip
      {...tool}
      hostnames={hostnames}
      onOpenWorkspace={onOpenWorkspace}
      onBuildPlan={onBuildPlan}
      buildDisabled={buildDisabled}
    />
  );
}

export type ActivityThinking = {
  text: string;
  done?: boolean;
  durationMs?: number;
};

export type ActivityEntry =
  | { type: "thinking"; thinking: ActivityThinking }
  | { type: "tool"; tool: ToolCallData };

export const ToolCallGroup = memo(function ToolCallGroup({
  tools = [],
  thinking = [],
  activity,
  onOpenDiff,
  onOpenSubagent,
  onOpenWorkspace,
  onBuildPlan,
  buildDisabled,
  onOpenRaw,
  includePlans = true,
  autoExpand = false,
  live = false,
  hostnames,
}: {
  tools: ToolCallData[];
  thinking?: ActivityThinking[];
  activity?: ActivityEntry[];
  onOpenDiff?: (tool: ToolCallData) => void;
  onOpenSubagent?: (tool: ToolCallData) => void;
  onOpenWorkspace?: (tool: ToolCallData) => void;
  onBuildPlan?: (tool: ToolCallData, plan: { title: string; content: string; workspaceLink?: string }, options?: { multiAgent?: boolean }) => void;
  buildDisabled?: boolean;
  onOpenRaw?: (tool: ToolCallData) => void;
  includePlans?: boolean;
  autoExpand?: boolean;
  live?: boolean;
  hostnames?: Record<string, string>;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const isTodoTool = (tool: ToolCallData) =>
    tool.kind === "todo" ||
    Boolean(tool.todos?.length) ||
    Boolean(todosFromToolPayload(tool.input, tool.result)?.length);
  const planTools = includePlans ? tools.filter((tool) => tool.kind === "plan") : [];
  const noteTools = tools.filter((tool) => tool.kind === "note");
  const todoTools = tools.filter((tool) => isTodoTool(tool));
  const regularTools = tools.filter(
    (tool) =>
      tool.kind !== "note" &&
      tool.kind !== "plan" &&
      !isTodoTool(tool),
  );
  const automationTools = tools.filter((tool) => isAutomationCardTool(tool));
  const regularEntries = regularTools.filter((tool) => !isAutomationCardTool(tool));
  const thinkingFromActivity = (activity || [])
 .filter((entry): entry is Extract<ActivityEntry, { type: "thinking" }> => entry.type === "thinking")
 .map((entry) => entry.thinking);
 const thinkingList = [...thinking, ...thinkingFromActivity];
 const combinedThinking = thinkingList.length
 ? {
 text: thinkingList.map((item) => item.text).filter(Boolean).join("\n\n"),
 done: thinkingList.every((item) => item.done !== false),
 durationMs: thinkingList.reduce((sum, item) => sum + (item.durationMs || 0), 0) || thinkingList.at(-1)?.durationMs,
 }
 : undefined;
 const groupTitle = activityGroupLabel([...regularEntries, ...noteTools], combinedThinking);
  const groupOpen = userOpen ?? Boolean(live || autoExpand);
  const lastToolId = regularTools[regularTools.length - 1]?.id;
  const renderTool = (tool: ToolCallData, nested = false) => (
    <ToolCallChip
      {...tool}
      hostnames={hostnames}
      nested={nested}
      onOpenDiff={() => onOpenDiff?.(tool)}
      onOpenSubagent={() => onOpenSubagent?.(tool)}
      onOpenWorkspace={() => onOpenWorkspace?.(tool)}
      onBuildPlan={(plan, options) => onBuildPlan?.(tool, plan, options)}
      buildDisabled={buildDisabled}
      onOpenRaw={() => onOpenRaw?.(tool)}
      autoExpand={!nested && Boolean(live || autoExpand) && tool.id === lastToolId}
      locked={false}
    />
  );
  const renderEntry = (entry: ActivityEntry, index: number) => {
    if (entry.type === "thinking") {
      if (!entry.thinking.text?.trim() && entry.thinking.done !== false) return null;
      return (
        <ThinkingBlock
          key={`thinking-${index}`}
          text={entry.thinking.text || "…"}
          done={entry.thinking.done !== false}
          durationMs={entry.thinking.durationMs}
          embedded
        />
      );
    }
    return <div key={entry.tool.id}>{renderTool(entry.tool)}</div>;
  };

  if (regularEntries.length === 0 && !combinedThinking) {
 return (
 <>
 {planTools.map((tool, index) => (
 <div key={toolReactKey(tool, index)}>{renderTool(tool)}</div>
 ))}
 {noteTools.map((tool, index) => (
 <div key={toolReactKey(tool, index)}>{renderTool(tool)}</div>
 ))}
 {todoTools.map((tool, index) => (
 <div key={toolReactKey(tool, index)}>{renderTool(tool)}</div>
 ))}
 {automationTools.map((tool) => (
 <div key={tool.id}>{renderTool(tool)}</div>
 ))}
 </>
 );
 }
 const activityRunning = [...regularEntries, ...noteTools, ...automationTools].some((tool) => isToolRunning(tool.status));
 return (
 <div className="w-full min-w-0" style={{ overflowAnchor: "none" }}>
 {todoTools.map((tool, index) => (
 <div key={toolReactKey(tool, index)}>{renderTool(tool)}</div>
 ))}
 {regularEntries.length === 1 && !combinedThinking ? (
 <div className="flex flex-col">
 {regularEntries.map((tool, index) => (
 <div key={toolReactKey(tool, index)}>{renderTool(tool)}</div>
 ))}
 </div>
 ) : (
 <div className="my-0.5 w-full">
 <button
 type="button"
 className={activityRowClass}
 onClick={() => setUserOpen((open) => open === null ? !groupOpen : !open)}
 >
 {activityRunning || combinedThinking?.done === false ? (
 <LoaderCircle className="size-3 shrink-0 animate-spin" />
 ) : (
 <ChevronRight className={cn("size-3 shrink-0 transition-transform", groupOpen && "rotate-90")} />
 )}
 <span className="truncate">{groupTitle}</span>
 </button>
 {groupOpen ? (
 <div className="flex flex-col gap-1 pl-4">
 {combinedThinking?.text || combinedThinking?.done === false ? (
 <ThinkingBlock
 text={combinedThinking.text || "…"}
 done={combinedThinking.done !== false}
 durationMs={combinedThinking.durationMs}
 embedded
 />
 ) : null}
 {planTools.map((tool, index) => (
 <div key={toolReactKey(tool, index)}>{renderTool(tool)}</div>
 ))}
 {noteTools.map((tool, index) => (
 <div key={toolReactKey(tool, index)}>{renderTool(tool)}</div>
 ))}
 {regularEntries.map((tool, index) => (
 <div key={toolReactKey(tool, index)}>{renderTool(tool, true)}</div>
 ))}
 {automationTools.map((tool) => (
 <div key={tool.id}>{renderTool(tool, true)}</div>
 ))}
 </div>
 ) : null}
 </div>
 )}
 </div>
 );

});
