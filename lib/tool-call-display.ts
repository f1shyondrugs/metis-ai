function joinAssistantText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (/\s$/.test(left) || /^\s/.test(right)) return left + right;
  if (/[a-zäöüß]{3,}[.!?]$/.test(left) && /^[A-ZÄÖÜ]/.test(right)) {
    return `${left}\n\n${right}`;
  }
  return left + right;
}

const RUNNING_TOOL_STATUSES = new Set([
  "running",
  "in_progress",
  "pending",
  "started",
  "executing",
  "queued",
]);

export function isToolRunning(status?: string): boolean {
  return Boolean(status && RUNNING_TOOL_STATUSES.has(status.toLowerCase()));
}

export type AssistantViewBlock<TTool> =
  | { type: "thinking"; content: string; done?: boolean; durationMs?: number }
  | {
      type: "compaction";
      status: "started" | "completed" | "error";
      beforeTokens?: number;
      targetTokens?: number;
      afterTokens?: number;
      removedMessages?: number;
      message?: string;
    }
  | { type: "text"; content: string }
  | {
 type: "tools";
 tools: TTool[];
 thinking?: { content: string; done?: boolean; durationMs?: number };
 };

type LayoutPart<TTool> =
  | { type: "thinking"; content: string; done?: boolean; durationMs?: number }
  | {
      type: "compaction";
      status: "started" | "completed" | "error";
      beforeTokens?: number;
      targetTokens?: number;
      afterTokens?: number;
      removedMessages?: number;
      message?: string;
    }
  | { type: "text"; content: string }
  | ({ type: "tool" } & TTool);

const STANDALONE_TOOL_KINDS = new Set([
  "todo",
  "plan",
  "note",
  "canvas",
]);

export function isStandaloneToolKind(kind?: string): boolean {
  return Boolean(kind && STANDALONE_TOOL_KINDS.has(kind));
}

export type ToolKind =
  | "plan"
  | "edit"
  | "read"
  | "shell"
  | "subagent"
  | "mcp"
  | "canvas"
  | "note"
  | "todo"
  | "browser"
  | "memory"
 | "compaction"
  | "other";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseToolValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function unwrapToolRecord(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 5) return asRecord(value);
  const parsed = parseToolValue(value);
  const record = asRecord(parsed);
  if (!record) return undefined;
  const nestedText = Array.isArray(record.content)
    ? record.content
      .map((item) => {
        const block = asRecord(item);
        const text = block?.text;
        if (typeof text === "string") return text;
        const inner = asRecord(text);
        return typeof inner?.text === "string" ? inner.text : "";
      })
      .filter(Boolean)
      .join("\n")
    : typeof record.content === "string"
      ? record.content
      : "";
  if (nestedText.trim().startsWith("{") || nestedText.trim().startsWith("[")) {
    const inner = unwrapToolRecord(nestedText, depth + 1);
    if (inner) return { ...record, ...inner };
  }
  for (const key of Object.keys(record)) {
    if (/ToolCall$/i.test(key) || /^(call_mcp_tool|CallMcpTool)$/i.test(key)) {
      const inner = unwrapToolRecord(record[key], depth + 1);
      if (inner) Object.assign(record, inner);
    }
  }
  for (const key of ["value", "result", "output", "args", "arguments", "input", "data", "params"]) {
    if (record[key] == null) continue;
    const inner = unwrapToolRecord(record[key], depth + 1);
    if (inner) Object.assign(record, inner);
  }
  return record;
}

function normalizeTodoStatus(status?: string): string | undefined {
  if (!status) return undefined;
  const value = status.trim();
  if (/^in[_\s-]?progress$/i.test(value)) return "in_progress";
  if (/^(complete[d]?|done)$/i.test(value)) return "completed";
  if (/^(cancel(led)?|cancelled)$/i.test(value)) return "cancelled";
  return value;
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(record[key]) || {};
}

function todosFromList(list: unknown): Array<{ id?: string; content: string; status?: string }> {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [{ content: item.trim() }];
    const entry = asRecord(item);
    if (!entry) return [];
    const content = [entry.content, entry.text, entry.title, entry.task]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
    if (!content) return [];
    const status = normalizeTodoStatus(typeof entry.status === "string" ? entry.status : undefined);
    return [{
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      content,
      ...(status ? { status } : {}),
    }];
  });
}

export function innerToolName(name: string, input?: unknown, result?: unknown): string {
  const outer = (name || "").trim() || "tool";
  const outerKey = outer.replace(/^(mcp[_:-])?(gateway[_:-])?/i, "");
  const isWrapper = /^(mcp|call_mcp_tool|callmcptool)$/i.test(outerKey);
  if (!isWrapper) return outer;
  const record = unwrapToolRecord(input) || unwrapToolRecord(result);
  const nested = [record?.toolName, record?.tool_name, record?.name, record?.tool]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return (nested || outer).trim();
}

export function classifyToolKind(name: string, input?: unknown, result?: unknown): ToolKind {
  const inner = innerToolName(name, input, result);
  const value = `${inner} ${name}`.toLowerCase();
  if (/compaction|context[ _-]?compact/.test(value)) return "compaction";
 if (/(todo)/.test(value)) return "todo";
  if (/(note)/.test(value)) return "note";
  if (/(memory|remember)/.test(value)) return "memory";
  if (/(browser|navigate|playwright|webfetch)/.test(value)) return "browser";
  if (value.includes("edit_plan") || /\bcreate_plan\b/.test(value)) return "plan";
  if (value.includes("edit_canvas") || /\bcreate_canvas\b/.test(value)) return "canvas";
  if (/(subagent|delegate|\btask\b)/.test(value) || /\bagents?\b/.test(inner.toLowerCase())) return "subagent";
  if (/\bplan\b/.test(value)) return "plan";
  if (/(edit|write|patch|replace|create_file|delete|remove|unlink)/.test(value)) return "edit";
  if (/(read|search|list|glob|grep)/.test(value)) return "read";
  if (/(shell|terminal|command|exec|run)/.test(value)) return "shell";
  if (/(mcp|connector|integration|getmcptools|call_mcp)/.test(value)) return "mcp";
  if (value.includes("canvas")) return "canvas";
  return "other";
}

export function todosFromToolPayload(
  input?: string,
  result?: string,
): Array<{ id?: string; content: string; status?: string }> | undefined {
  for (const raw of [input, result]) {
    if (!raw) continue;
    const record = unwrapToolRecord(raw);
    const list = record?.todos ?? record?.items ?? record?.tasks ?? record?.todoList;
    const todos = todosFromList(list);
    if (todos.length) return todos;
  }
  return undefined;
}

export function planFromToolPayload(input?: string, result?: string, detail?: string): {
  title: string;
  content: string;
  workspaceLink?: string;
} | undefined {
  for (const source of [input, result, detail]) {
    if (!source) continue;
    const record = unwrapToolRecord(source);
    if (record) {
      const plan = nestedRecord(record, "plan");
      const value = nestedRecord(record, "value");
      const content = [
        record.content,
        record.plan,
        plan.content,
        value.content,
        value.plan,
      ].map(nonEmptyString).find(Boolean);
      if (content) {
        const title = [
          record.title,
          record.name,
          plan.title,
          plan.name,
          value.title,
          value.name,
        ].map(nonEmptyString).find(Boolean);
        const workspaceLink = [
          record.workspaceLink,
          plan.workspaceLink,
          value.workspaceLink,
        ].map(nonEmptyString).find(Boolean);
        const id = nonEmptyString(record.id) || nonEmptyString(plan.id) || nonEmptyString(value.id);
        return {
          title: title || "Plan",
          content,
          ...(workspaceLink
            ? { workspaceLink }
            : id ? { workspaceLink: `workspace://plan/${id}` } : {}),
        };
      }
    } else if (source.trim() && !source.trim().startsWith("{")) {
      return { title: "Plan", content: source.trim() };
    }
  }
  return undefined;
}

export function enrichToolDisplay(tool: {
  name: string;
  input?: string;
  result?: string;
  kind?: string;
}): { name: string; kind: ToolKind; todos?: Array<{ id?: string; content: string; status?: string }> } {
  const name = innerToolName(tool.name, tool.input, tool.result);
  const classified = classifyToolKind(name, tool.input, tool.result);
  const todos = todosFromToolPayload(tool.input, tool.result);
  const kind: ToolKind = todos?.length || classified === "todo"
    ? "todo"
    : tool.kind && tool.kind !== "mcp" && tool.kind !== "other"
      ? tool.kind as ToolKind
      : classified;
  return {
    name: name || tool.name,
    kind,
    ...(todos?.length ? { todos } : {}),
  };
}

export function withEnrichedToolDisplay<T extends {
  name?: string;
  input?: string;
  result?: string;
  kind?: string;
  todos?: Array<{ id?: string; content: string; status?: string }>;
}>(tool: T): T {
  const enriched = enrichToolDisplay({
    name: tool.name || "",
    input: tool.input,
    result: tool.result,
    kind: tool.kind,
  });
  return {
    ...tool,
    name: enriched.name || tool.name,
    kind: enriched.kind as T["kind"],
    ...(enriched.todos?.length && !tool.todos?.length ? { todos: enriched.todos } : {}),
  };
}

export function layoutAssistantParts<TTool extends { kind?: string }>(
  parts: Array<LayoutPart<TTool>>,
): AssistantViewBlock<TTool>[] {
  // Plans and todos are state surfaces, not append-only history. Models may call
  // create/edit_plan or write_todos repeatedly while working; rendering every
  // intermediate call produces duplicate plan/task cards. Normalize tools once,
  // then keep only the latest plan and todo for this assistant turn.
  const normalized = parts.map((part) => {
    if (part.type !== "tool") return part;
    const { type: _type, ...tool } = part;
    void _type;
    const next = withEnrichedToolDisplay(tool as unknown as TTool & {
      name?: string;
      input?: string;
      result?: string;
      kind?: string;
    }) as unknown as TTool;
    return { type: "tool" as const, ...next };
  });
  const lastStateIndex = new Map<string, number>();
  normalized.forEach((part, index) => {
    if (part.type === "tool" && (part.kind === "plan" || part.kind === "todo")) {
      lastStateIndex.set(part.kind, index);
    }
  });

  const blocks: AssistantViewBlock<TTool>[] = [];
 let tools: TTool[] = [];
 let pendingThinking: { content: string; done?: boolean; durationMs?: number } | undefined;

 const takeThinking = () => {
 const thinking = pendingThinking;
 pendingThinking = undefined;
 return thinking;
 };

 const flushTools = () => {
 if (!tools.length) return;
 const thinking = takeThinking();
 blocks.push({ type: "tools", tools, ...(thinking ? { thinking } : {}) });
 tools = [];
 };

 const flushThinking = () => {
 if (tools.length) flushTools();
 const thinking = takeThinking();
 if (!thinking) return;
 blocks.push({ type: "thinking", ...thinking });
 };

 const pushStandalone = (tool: TTool) => {
 flushTools();
 // Keep pending thinking for the following regular tool group.
 const last = blocks.at(-1);
    const isPlanTodo = tool.kind === "plan" || tool.kind === "todo";
    const lastIsPlanTodoGroup =
      last?.type === "tools" &&
      last.tools.length > 0 &&
      last.tools.every((item) => item.kind === "plan" || item.kind === "todo");
    if (isPlanTodo && lastIsPlanTodoGroup) {
      const byKind = new Map(last.tools.map((item) => [item.kind, item]));
      byKind.set(tool.kind, tool);
      // Cursor-like presentation: the plan is the primary surface and the task
      // checklist sits directly below it in the same visual block.
      last.tools = [byKind.get("plan"), byKind.get("todo")].filter(Boolean) as TTool[];
      return;
    }
    blocks.push({ type: "tools", tools: [tool] });
  };

  normalized.forEach((part, index) => {
    if (part.type === "thinking") {
 if (tools.length) flushTools();
 const next = {
 content: part.content,
 done: part.done,
 durationMs: part.durationMs,
 };
 if (pendingThinking) {
 pendingThinking = {
 content: [pendingThinking.content, next.content].filter(Boolean).join("\n\n"),
 done: next.done,
 durationMs: (pendingThinking.durationMs || 0) + (next.durationMs || 0) || next.durationMs,
 };
 } else {
 pendingThinking = next;
 }
 return;
 }
 if (part.type === "compaction") {
 flushTools();
 flushThinking();
 blocks.push(part);
 return;
 }
 if (part.type === "text") {
 if (!part.content.trim()) return;
 flushTools();
 flushThinking();
 const last = blocks.at(-1);
      if (last?.type === "text") last.content = joinAssistantText(last.content, part.content);
      else blocks.push({ type: "text", content: part.content });
      return;
    }
    if (
      (part.kind === "plan" || part.kind === "todo") &&
      lastStateIndex.get(part.kind) !== index
    ) {
      return;
    }
    if (isStandaloneToolKind(part.kind)) {
      pushStandalone(part);
      return;
    }
    tools.push(part);
  });
  flushTools();
    flushThinking();
  return coalesceActivityBlocks(blocks);
}

function mergeBlockThinking(
 a?: { content: string; done?: boolean; durationMs?: number },
 b?: { content: string; done?: boolean; durationMs?: number },
) {
 if (!a) return b;
 if (!b) return a;
 return {
 content: [a.content, b.content].filter(Boolean).join("\n\n"),
 done: a.done !== false && b.done !== false,
 durationMs: (a.durationMs || 0) + (b.durationMs || 0) || b.durationMs || a.durationMs,
 };
}

function coalesceActivityBlocks<TTool extends { kind?: string }>(
 blocks: AssistantViewBlock<TTool>[],
): AssistantViewBlock<TTool>[] {
 const out: AssistantViewBlock<TTool>[] = [];
 for (const block of blocks) {
 const last = out.at(-1);
 if (block.type === "tools" && last?.type === "thinking") {
 out.pop();
 out.push({
 type: "tools",
 tools: block.tools,
 thinking: mergeBlockThinking(
 { content: last.content, done: last.done, durationMs: last.durationMs },
 block.thinking,
 ),
 });
 continue;
 }
 if (block.type === "thinking" && last?.type === "tools") {
 last.thinking = mergeBlockThinking(last.thinking, {
 content: block.content,
 done: block.done,
 durationMs: block.durationMs,
 });
 continue;
 }
 if (block.type === "tools" && last?.type === "tools") {
 const blockHasStateSurface = block.tools.some((tool) => tool.kind === "plan" || tool.kind === "todo");
 const lastHasStateSurface = last.tools.some((tool) => tool.kind === "plan" || tool.kind === "todo");
 if (!blockHasStateSurface && !lastHasStateSurface) {
 last.tools = [...last.tools, ...block.tools];
 last.thinking = mergeBlockThinking(last.thinking, block.thinking);
 continue;
 }
 }
 out.push(block);
 }
 return out;
}

export function looksLikeStructuredPayload(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function compactToolPreview(value?: string, max = 88): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || looksLikeStructuredPayload(normalized)) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

const LOCAL_TARGETS = new Set(["server", "local", "laptop"]);
const SHELL_TOOL_NAMES = new Set([
  "execute_command",
  "remote_client_terminal",
  "shell",
  "bash",
  "run_terminal_cmd",
]);
const PATH_TOOL_NAMES = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "list_directory",
  "read",
  "edit",
  "write",
  "grep",
]);

function parseJsonObject(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function looksLikeShellCommand(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || looksLikeStructuredPayload(trimmed)) return false;
  return /\s/.test(trimmed) || /^[A-Za-z0-9_./\\:-]+$/.test(trimmed);
}

function parseNestedArgs(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") return parseJsonObject(value);
  return asRecord(value);
}

function unwrapToolPayload(name: string, payload: Record<string, unknown> | undefined) {
  const nestedTool = stringField(payload, "tool") || stringField(payload, "toolName");
  const nested = parseNestedArgs(payload?.arguments) || parseNestedArgs(payload?.args);
  const isWrapper = name === "call_mcp_tool" || Boolean(nested && nestedTool);
  if (isWrapper && nested) {
    return {
      toolName: nestedTool || name,
      args: { ...payload, ...nested },
    };
  }
  return { toolName: name, args: payload ?? {} };
}

function extractCommand(args: Record<string, unknown>, fallback?: string): string | undefined {
  const command = stringField(args, "command") || stringField(args, "cmd") || stringField(args, "script");
  if (command) return command.replace(/\s+/g, " ").trim();
  const data = stringField(args, "data");
  if (data && looksLikeShellCommand(data)) return data.replace(/\s+/g, " ").trim();
  if (fallback && !looksLikeStructuredPayload(fallback) && looksLikeShellCommand(fallback)) {
    return fallback.replace(/\s+/g, " ").trim();
  }
  return undefined;
}

function extractPath(args: Record<string, unknown>, fallback?: string): string | undefined {
  return fallback?.trim()
    || stringField(args, "path")
    || stringField(args, "file")
    || stringField(args, "filePath")
    || stringField(args, "filename");
}

function clientIdFromTarget(target?: string): string | undefined {
  if (!target?.startsWith("client:")) return undefined;
  const id = target.slice("client:".length).trim();
  return id || undefined;
}

function isRemoteTool(toolName: string, args: Record<string, unknown>): boolean {
  const target = stringField(args, "target");
  const clientId = stringField(args, "client_id") || stringField(args, "clientId") || clientIdFromTarget(target);
  if (target?.startsWith("client:")) return true;
  if (clientId) return true;
  if (toolName === "remote_client_terminal") return true;
  if (target && (toolName === "execute_command" || SHELL_TOOL_NAMES.has(toolName))) {
    return !LOCAL_TARGETS.has(target.toLowerCase());
  }
  return false;
}

function shortClientId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function resolveHostname(
  args: Record<string, unknown>,
  hostnames?: Record<string, string>,
): string | undefined {
  const payloadHostname = stringField(args, "hostname");
  if (payloadHostname) return payloadHostname;
  const target = stringField(args, "target");
  const fromClientId = stringField(args, "client_id") || stringField(args, "clientId");
  const fromTarget = clientIdFromTarget(target);
  if (fromClientId && hostnames?.[fromClientId]) return hostnames[fromClientId];
  if (fromTarget && hostnames?.[fromTarget]) return hostnames[fromTarget];
  const clientName = stringField(args, "client")
    || stringField(args, "client_name")
    || stringField(args, "clientName");
  if (clientName) return clientName;
  if (fromClientId) return shortClientId(fromClientId);
  if (fromTarget) return shortClientId(fromTarget);
  if (target && !LOCAL_TARGETS.has(target.toLowerCase())) {
    return hostnames?.[target] || target;
  }
  return undefined;
}

function humanToolName(name: string): string {
  if (name === "call_mcp_tool") return "tool";
  return name.replaceAll("_", " ");
}

function basenamePath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || trimmed;
}

function extractLineRange(args: Record<string, unknown>): string | undefined {
  const start = numberField(args, "offset")
    ?? numberField(args, "startLine")
    ?? numberField(args, "start_line")
    ?? numberField(args, "line");
  const limit = numberField(args, "limit");
  const end = numberField(args, "endLine")
    ?? numberField(args, "end_line")
    ?? (start != null && limit != null ? start + Math.max(limit, 1) - 1 : undefined);
  if (start == null) return undefined;
  if (end != null && end !== start) return `L${start}-${end}`;
  return `L${start}`;
}

function extractSearchPattern(args: Record<string, unknown>): string | undefined {
  return stringField(args, "pattern")
    || stringField(args, "query")
    || stringField(args, "search_term")
    || stringField(args, "glob_pattern")
    || stringField(args, "regex");
}

export type ToolActionIcon =
  | "folder"
  | "search"
  | "read"
  | "edit"
  | "shell"
  | "mcp"
  | "browser"
  | "subagent"
  | "compress"
  | "other";

export type ToolActionCategory = "file" | "search" | "edit" | "shell" | "browser" | "memory" | "tool";

export function resolveToolAction(name?: string, kind?: string): {
  verb: string;
  icon: ToolActionIcon;
  category: ToolActionCategory;
} {
  const value = (name || "").toLowerCase();
  if (kind === "compaction" || /(compact|compaction)/.test(value)) {
    return { verb: "Compacted", icon: "compress", category: "tool" };
  }
  if (kind === "subagent" || /(subagent|delegate)/.test(value)) {
    return { verb: "Delegated", icon: "subagent", category: "tool" };
  }
  if (kind === "memory" || /(memory|remember)/.test(value)) {
    const verb = /(list)/.test(value) ? "Listed" : /(delete|remove)/.test(value) ? "Deleted" : /(edit|update)/.test(value) ? "Updated" : "Saved";
    return { verb, icon: "other", category: "memory" };
  }
  if (kind === "browser" || /(browser_|navigate|playwright|webfetch|web_fetch)/.test(value)) {
    return { verb: "Browsed", icon: "browser", category: "browser" };
  }
  if (kind === "shell" || SHELL_TOOL_NAMES.has(value) || /(execute_command|terminal)/.test(value)) {
    return { verb: "Ran", icon: "shell", category: "shell" };
  }
  if (kind === "edit" || /(write_file|edit_file|delete_file|apply_patch|strreplace)/.test(value)) {
    return { verb: /delete|remove|unlink/.test(value) ? "Deleted" : "Edited", icon: "edit", category: "edit" };
  }
  if (/(grep|ripgrep)/.test(value)) {
    return { verb: "Grepped", icon: "search", category: "search" };
  }
  if (/(search_tools|get_mcp_tools|list_mcp|search_registry)/.test(value)) {
    return { verb: "Searched", icon: "mcp", category: "search" };
  }
  if (/(web_search|context_search|exa_|github_search)/.test(value) || (kind === "mcp" && value.includes("search"))) {
    return { verb: "Searched", icon: "search", category: "search" };
  }
  if (/(list_directory|glob|listdir)/.test(value)) {
    return { verb: "Explored", icon: "folder", category: "file" };
  }
  if (kind === "read" || /(read_file|read_lints|^read$)/.test(value)) {
    return { verb: "Read", icon: "read", category: "file" };
  }
  if (kind === "mcp" || value.includes("mcp") || value === "call_mcp_tool") {
    return { verb: "Used", icon: "mcp", category: "tool" };
  }
  return { verb: "Used", icon: "other", category: "tool" };
}

export function toolCallHeadline(input: {
  name: string;
  kind?: string;
  input?: string;
  detail?: string;
  path?: string;
  hostnames?: Record<string, string>;
}): { title: string; preview?: string; remote?: boolean; icon: ToolActionIcon; verb: string } {
  const payload = parseJsonObject(input.input) || parseJsonObject(input.detail);
  const unwrapped = unwrapToolPayload(input.name, payload);
  const args = unwrapped.args;
  const toolName = unwrapped.toolName === "call_mcp_tool" ? input.name : unwrapped.toolName;
  const action = resolveToolAction(toolName, input.kind);
  const command = extractCommand(args, input.kind === "shell" ? input.input : undefined);
  const filePath = extractPath(args, input.path);
  const remote = isRemoteTool(toolName, args);
  const hostname = remote ? resolveHostname(args, input.hostnames) : undefined;
  const pattern = extractSearchPattern(args);
  const lineRange = extractLineRange(args);
  const fallbackName = humanToolName(toolName === "call_mcp_tool" ? input.name : toolName);
  const shortPath = filePath ? basenamePath(filePath) : undefined;

  let core: string;
  if (action.category === "shell") {
    core = command ? `${action.verb} ${command}` : action.verb;
  } else if (action.verb === "Grepped") {
    core = pattern ? `${action.verb} ${pattern}` : action.verb;
  } else if (action.verb === "Searched" && /(search_tools|get_mcp_tools|list_mcp)/i.test(toolName)) {
    core = "Searched MCP tools";
  } else if (action.verb === "Explored") {
    core = shortPath || pattern ? `${action.verb} ${shortPath || pattern}` : action.verb;
  } else if (action.category === "file" || action.category === "edit") {
    const target = shortPath || fallbackName;
    core = `${action.verb} ${target}${lineRange ? ` ${lineRange}` : ""}`;
  } else if (command || filePath) {
    core = `${action.verb} ${command || shortPath || filePath}`;
  } else if (pattern) {
    core = `${action.verb} ${pattern}`;
  } else {
    core = fallbackName === "tool" ? `${action.verb} tool` : fallbackName;
  }

  const title = remote && hostname ? `${hostname}: ${core}` : core;
  const previewSource = [
    action.verb === "Grepped" ? filePath : undefined,
    action.verb === "Searched" ? pattern : undefined,
    stringField(args, "description"),
    input.detail,
  ].find((value) => {
    if (!value) return false;
    if (value === command || value === filePath || value === core || value === shortPath) return false;
    if (pattern && value === pattern && core.includes(pattern)) return false;
    return true;
  });
  const preview = compactToolPreview(previewSource);
  return {
    title,
    icon: action.icon,
    verb: action.verb,
    ...(preview && preview !== title && preview !== core ? { preview } : {}),
    ...(remote ? { remote: true } : {}),
  };
}

export function remoteClientHostnameMap(
  clients: Array<{ id: string; hostname?: string; name?: string; os?: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const client of clients) {
    const host = client.hostname?.trim() || client.name?.trim();
    if (!host) continue;
    map[client.id] = host;
    const os = (client.os || "").toLowerCase();
    if (os.includes("win") || os.includes("pc")) map.pc ??= host;
  }
  return map;
}

function countedLabel(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

export function truncateToolText(value: string, max = 2400): string {
  if (value.length <= max) return value;
  const keepHead = Math.max(800, Math.floor(max * 0.7));
  const keepTail = Math.max(400, max - keepHead - 80);
  const omitted = value.length - keepHead - keepTail;
  return `${value.slice(0, keepHead)}\n… [${omitted} chars omitted]\n${value.slice(-keepTail)}`;
}

export function compactFileDiff(before?: string, after?: string, contextLines = 2): string {
  if (before == null && after == null) return "";
  if ((before ?? "") === (after ?? "")) return "(no line changes)";
  const beforeLines = (before ?? "").split("\n");
  const afterLines = (after ?? "").split("\n");
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start += 1;
  }
  let beforeEnd = beforeLines.length;
  let afterEnd = afterLines.length;
  while (beforeEnd > start && afterEnd > start && beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const from = Math.max(0, start - contextLines);
  const afterTo = Math.min(afterLines.length, afterEnd + contextLines);
  const lines = [`@@ -${from + 1},${Math.min(beforeLines.length, beforeEnd + contextLines) - from} +${from + 1},${afterTo - from} @@`];
  for (let index = from; index < start; index += 1) lines.push(` ${beforeLines[index]}`);
  for (let index = start; index < beforeEnd; index += 1) lines.push(`-${beforeLines[index]}`);
  for (let index = start; index < afterEnd; index += 1) lines.push(`+${afterLines[index]}`);
  for (let index = afterEnd; index < afterTo; index += 1) lines.push(` ${afterLines[index]}`);
  return truncateToolText(lines.join("\n"), 4000);
}

export function toolGroupLabel(tools: Array<{ name?: string; kind?: string }>): string {
  if (tools.length <= 0) return "Tools";
  if (tools.length === 1) return "Tool";

  const counts: Record<ToolActionCategory, number> = {
    file: 0,
    search: 0,
    edit: 0,
    shell: 0,
    browser: 0,
    memory: 0,
    tool: 0,
  };
  for (const tool of tools) {
    counts[resolveToolAction(tool.name, tool.kind).category] += 1;
  }

  const parts: string[] = [];
  if (counts.file) {
    parts.push(counts.file === 1 ? "Explored 1 file" : `Explored ${counts.file} files`);
  }
  if (counts.search) parts.push(countedLabel(counts.search, "search", "searches"));
  if (counts.edit) parts.push(countedLabel(counts.edit, "edit", "edits"));
  if (counts.shell) parts.push(countedLabel(counts.shell, "command", "commands"));
  if (counts.browser) parts.push(countedLabel(counts.browser, "browser tool", "browser tools"));
  if (counts.memory) parts.push(countedLabel(counts.memory, "memory", "memories"));
  if (counts.tool) parts.push(countedLabel(counts.tool, "tool", "tools"));
 return parts.join(", ") || "Tools";
}


export function memoryCardFromPayload(
 name: string,
 input?: unknown,
 result?: unknown,
): { title: string; body: string } {
 const inner = innerToolName(name, input, result).toLowerCase();
 const record = unwrapToolRecord(result) || unwrapToolRecord(input) || {};
 const list = Array.isArray(record.memories)
 ? record.memories
 : Array.isArray(record.items)
 ? record.items
 : [];
 const contents = list.flatMap((item) => {
 if (typeof item === "string" && item.trim()) return [item.trim()];
 const entry = asRecord(item);
 const content = nonEmptyString(entry?.content) || nonEmptyString(entry?.text);
 return content ? [content] : [];
 });
 const memory = asRecord(record.memory);
 const single =
 nonEmptyString(record.content)
 || nonEmptyString(record.text)
 || nonEmptyString(memory?.content)
 || nonEmptyString(memory?.text);
 const isList = /list/.test(inner);
 const title = isList
 ? (contents.length === 1 ? "Memory" : "Memories")
 : /(delete|remove)/.test(inner)
 ? "Deleted memory"
 : /(edit|update)/.test(inner)
 ? "Updated memory"
 : /(add|create|remember)/.test(inner)
 ? "Saved memory"
 : "Memory";
 if (isList && !contents.length && !single) return { title, body: "No memories" };
 const body = contents.length
 ? (contents.length === 1 ? contents[0] : contents.map((item) => `• ${item}`).join("\n"))
 : single || nonEmptyString(record.error) || "Memory updated";
 return { title, body };
}

export function formatThoughtDuration(ms?: number): string | null {
 if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
 if (ms < 1000) return `${Math.round(ms)}ms`;
 const s = ms / 1000;
 if (s < 10 && !Number.isInteger(s)) return `${s.toFixed(1)}s`;
 return `${Math.round(s)}s`;
}

export function activityGroupLabel(
 tools: Array<{ name?: string; kind?: string }>,
 thinking?: { done?: boolean; durationMs?: number } | null,
): string {
 const duration = formatThoughtDuration(thinking?.durationMs ?? undefined);
 const thought = thinking
 ? (thinking.done === false
 ? (duration ? `Thinking for ${duration}` : "Thinking")
 : (duration ? `Thought for ${duration}` : "Thought"))
 : null;
 const toolsLabel = tools.length ? toolGroupLabel(tools) : null;
 if (thought && toolsLabel) return `${thought} — ${toolsLabel}`;
 return thought || toolsLabel || "Tools";
}


export type MergeableChatMessage = {
  id: string;
  role?: string;
  streaming?: boolean;
  content?: string;
  thinking?: string;
  parts?: Array<{ type?: string; content?: string }>;
  tools?: unknown[];
  serverSequence?: number;
  createdAt?: string;
};

export function messageLiveWeight(message: MergeableChatMessage) {
  const parts = message.parts ?? [];
  return (
    (message.content?.length || 0) +
    (message.thinking?.length || 0) +
    parts.reduce((sum, part) => {
      if (part.type === "text" || part.type === "thinking") return sum + (part.content?.length || 0);
      return sum + 24;
    }, 0) +
    (message.tools?.length || 0) * 24
  );
}

export function adoptOptimisticAssistantId<T extends MergeableChatMessage>(current: T[], incoming: T[]) {
  const optimistic = [...current].reverse().find((message) => (
    message.role === "assistant" && message.streaming && message.id.startsWith("a-")
  ));
  const serverAssistant = [...incoming].reverse().find((message) => message.role === "assistant");
  if (!optimistic || !serverAssistant || optimistic.id === serverAssistant.id) return current;
  return current.map((message) => (
    message.id === optimistic.id ? { ...message, id: serverAssistant.id } : message
  ));
}

export function mergeChatMessages<T extends MergeableChatMessage>(current: T[], incoming: T[]) {
  const live = adoptOptimisticAssistantId(current, incoming);
  const byId = new Map(live.map((message) => [message.id, message]));
  const order = new Map(live.map((message, index) => [message.id, index]));
  incoming.forEach((message) => {
    const existing = byId.get(message.id);
    if (!order.has(message.id)) order.set(message.id, order.size);
    if (!existing) {
      byId.set(message.id, message);
      return;
    }
    if (existing.streaming) {
      const incomingWeight = messageLiveWeight(message);
      const existingWeight = messageLiveWeight(existing);
      byId.set(
        message.id,
        incomingWeight > existingWeight
          ? { ...existing, ...message, streaming: true }
          : { ...message, ...existing, streaming: true },
      );
      return;
    }
    byId.set(message.id, message);
  });
  return [...byId.values()].sort((a, b) => {
    const sequenceOrder = (a.serverSequence || 0) - (b.serverSequence || 0);
    if (sequenceOrder) return sequenceOrder;
    const createdAtOrder = (a.createdAt || "").localeCompare(b.createdAt || "");
    return createdAtOrder || (order.get(a.id) || 0) - (order.get(b.id) || 0);
  });
}
