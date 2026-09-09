import type { ToolPart } from "@/lib/store";
import { isSubagentControlName, isSubagentSpawnName } from "@/lib/subagent-bar";

export type AutomationCardInfo = {
  id: string;
  title: string;
  prompt: string;
  scheduleLabel?: string;
  automationLink: string;
  actionLabel: string;
};

function compactToolName(name: string) {
  return name.replace(/[\s_-]/g, "").toLowerCase();
}

export function isMcpWrapperName(name: string) {
  const value = compactToolName(name);
  return value === "callmcptool" || value === "mcp" || value === "callmcp";
}

function nestedToolNameFrom(source: unknown, depth = 0): string | undefined {
  if (depth > 6 || source == null) return undefined;
  if (typeof source === "string") {
    const plain = source.trim();
    if (!plain) return undefined;
    try {
      return nestedToolNameFrom(JSON.parse(plain), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(source)) {
    for (const item of source) {
      const nested = nestedToolNameFrom(item, depth + 1);
      if (nested) return nested;
    }
    return undefined;
  }
  if (typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  const direct = [record.toolName, record.tool]
    .find((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (direct && !isMcpWrapperName(direct)) return direct.trim();
  return nestedToolNameFrom(record.arguments, depth + 1)
    || nestedToolNameFrom(record.args, depth + 1)
    || nestedToolNameFrom(record.input, depth + 1);
}

export function resolveMcpToolName(name: string, ...sources: unknown[]): string {
  if (!isMcpWrapperName(name)) return name;
  for (const source of sources) {
    const nested = nestedToolNameFrom(source);
    if (nested) return nested;
  }
  return name;
}

export function classifyTool(name: string, input?: unknown): ToolPart["kind"] {
  const value = resolveMcpToolName(name, input).toLowerCase();
  if (value.includes("automation")) return "automation";
  if (isSubagentControlName(value)) return "mcp";
  if (isSubagentSpawnName(value)) return "subagent";
  if (/(todo)/.test(value)) return "todo";
  if (/(note)/.test(value)) return "note";
  if (/(memory|remember)/.test(value)) return "memory";
  if (/(keyword|chat)/.test(value)) return "mcp";
  if (
    /(browser|navigate|playwright|webfetch|web_fetch|web_search|websearch|web_reader|webreader|browse_page|search_web|x_search|exa)/.test(
      value,
    )
  ) {
    return "browser";
  }
  if (value.includes("edit_plan")) return "plan";
  if (value.includes("edit_canvas")) return "canvas";
  if (value.includes("plan")) return "plan";
  if (/(edit|write|patch|replace|create_file|delete|remove|unlink)/.test(value)) return "edit";
  if (/(read|search|list|glob|grep)/.test(value)) return "read";
  if (/(shell|terminal|command|exec|run)/.test(value)) return "shell";
  if (isMcpWrapperName(value) || /(mcp|connector|integration)/.test(value)) return "mcp";
  if (value.includes("canvas")) return "canvas";
  return "other";
}

export function toolDetailFromArgs(args: unknown): string | undefined {
  if (args == null) return undefined;
  const record =
    typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : null;
  const value = record
    ? record.query ??
      record.url ??
      record.command ??
      record.path ??
      record.pattern ??
      record.toolName ??
      record.prompt
    : args;
  const text = typeof value === "string" ? value : value != null ? JSON.stringify(value) : "";
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
}

export function automationActionLabel(name: string) {
  const value = name.toLowerCase();
  if (value.includes("create_automation")) return "Created Automation";
  if (value.includes("update_automation")) return "Updated Automation";
  if (value.includes("pause_automation")) return "Paused Automation";
  if (value.includes("resume_automation")) return "Resumed Automation";
  if (value.includes("delete_automation")) return "Deleted Automation";
  return null;
}

export function formatAutomationSchedule(schedule: unknown) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return undefined;
  const value = schedule as Record<string, unknown>;
  if (value.kind === "once" && typeof value.at === "string") {
    const stamp = Date.parse(value.at);
    if (Number.isFinite(stamp)) {
      return `Once · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(stamp))}`;
    }
    return `Once · ${value.at}`;
  }
  if (value.kind === "interval" && typeof value.everyMinutes === "number") {
    return `Every ${value.everyMinutes} minutes`;
  }
  if (value.kind === "days" && typeof value.everyDays === "number") {
    return `Every ${value.everyDays} day${value.everyDays === 1 ? "" : "s"}`;
  }
  if (value.kind === "monthly" && typeof value.dayOfMonth === "number") {
    return `Monthly · day ${value.dayOfMonth}`;
  }
  return undefined;
}

function visitAutomationPayload(
  candidate: unknown,
  depth: number,
  acc: {
    id: string;
    title: string;
    prompt: string;
    scheduleLabel?: string;
    automationLink?: string;
    singular?: boolean;
  },
): typeof acc {
  if (depth > 8 || candidate == null) return acc;
  if (typeof candidate === "string") {
    const plain = candidate.trim();
    if (!plain) return acc;
    try {
      return visitAutomationPayload(JSON.parse(plain), depth + 1, acc);
    } catch {
      const link = plain.match(/automation:\/\/([^/?#\s]+)/i);
      if (link && !acc.id) acc.id = decodeURIComponent(link[1]);
      if (link && !acc.automationLink) acc.automationLink = `automation://${acc.id || decodeURIComponent(link[1])}`;
      return acc;
    }
  }
  if (Array.isArray(candidate)) {
    for (const item of candidate) acc = visitAutomationPayload(item, depth + 1, acc);
    return acc;
  }
  if (typeof candidate !== "object") return acc;
  const parsed = candidate as Record<string, unknown>;
  if (parsed.automation && typeof parsed.automation === "object" && !Array.isArray(parsed.automation)) {
    acc.singular = true;
  }
  const nested = parsed.automation && typeof parsed.automation === "object" && !Array.isArray(parsed.automation)
    ? parsed.automation as Record<string, unknown>
    : parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
      ? parsed.value as Record<string, unknown>
      : parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments)
        ? parsed.arguments as Record<string, unknown>
        : {};
  if (typeof nested.id === "string" && nested.id.trim() && !acc.id) acc.id = nested.id.trim();
  else if (typeof parsed.id === "string" && parsed.id.trim() && !acc.id && acc.singular) acc.id = parsed.id.trim();
  if (typeof nested.name === "string" && nested.name.trim() && !acc.title) acc.title = nested.name.trim();
  else if (typeof parsed.name === "string" && parsed.name.trim() && !acc.title && !isMcpWrapperName(parsed.name)) {
    acc.title = parsed.name.trim();
  }
  if (typeof nested.prompt === "string" && nested.prompt && !acc.prompt) acc.prompt = nested.prompt;
  else if (typeof parsed.prompt === "string" && parsed.prompt && !acc.prompt) acc.prompt = parsed.prompt;
  acc.scheduleLabel = formatAutomationSchedule(nested.schedule)
    || formatAutomationSchedule(parsed.schedule)
    || acc.scheduleLabel;
  if (typeof parsed.automationLink === "string" && parsed.automationLink.trim()) {
    acc.automationLink = parsed.automationLink.trim();
  }
  for (const key of ["automation", "value", "content", "text", "result", "arguments", "args", "input"]) {
    if (key in parsed) acc = visitAutomationPayload(parsed[key], depth + 1, acc);
  }
  return acc;
}

export function parseAutomationCard(name: string, ...sources: unknown[]): AutomationCardInfo | null {
  const resolved = resolveMcpToolName(name, ...sources);
  let actionLabel = automationActionLabel(resolved);
  const acc = visitAutomationPayload(sources, 0, { id: "", title: "", prompt: "" });
  if (!acc.id) return null;
  if (!actionLabel) {
    if (!acc.singular && !acc.automationLink) return null;
    actionLabel = "Created Automation";
  }
  return {
    id: acc.id,
    title: acc.title || "Automation",
    prompt: acc.prompt,
    scheduleLabel: acc.scheduleLabel,
    automationLink: acc.automationLink || `automation://${acc.id}`,
    actionLabel,
  };
}
