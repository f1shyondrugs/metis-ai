export function normalizeToolName(name: string) {
  return name.replace(/[\s-]+/g, "_").toLowerCase();
}

/** Status/wait/cancel tools are not delegation, even when they carry an agentId. */
export function isSubagentControlName(name: string) {
  const value = normalizeToolName(name);
  return (
    /(^|_)(subagent|delegate)_(status|cancel|wait)(_|$)/.test(value) ||
    /subagent(status|cancel)|delegatestatus/.test(value) ||
    value.includes("subagent_status") ||
    value.includes("subagent_cancel") ||
    value.includes("subagent_wait")
  );
}

/** Real spawn/delegate tools that should appear in the chat bar. */
export function isSubagentSpawnName(name: string) {
  const value = normalizeToolName(name);
  if (isSubagentControlName(value)) return false;
  return (
    value === "task" ||
    value === "delegate_subagent" ||
    value.includes("delegate_subagent") ||
    /(^|_)(spawn|create|start|launch)_?subagent$/.test(value) ||
    /(^|_)subagent$/.test(value)
  );
}

export function isChatBarSubagent(tool: {
  name: string;
  kind?: string;
  subagent?: { agentId?: string; chatId?: string } | null;
}) {
  if (isSubagentControlName(tool.name)) return false;
  if (isSubagentSpawnName(tool.name)) return true;
  return tool.kind === "subagent" && Boolean(tool.subagent?.agentId || tool.subagent?.chatId);
}

export function dedupeChatBarSubagents<T extends {
  id: string;
  subagent?: { agentId?: string; chatId?: string } | null;
}>(tools: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const tool of tools) {
    const key = tool.subagent?.agentId || tool.subagent?.chatId || tool.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tool);
  }
  return out;
}

export function isChildRunLive(status?: string | null) {
  const value = String(status || "").toLowerCase();
  return value === "running" || value === "paused" || value.startsWith("waiting");
}

export function isBarSubagentLive(
  tool: {
    status?: string;
    sourceMessageCreatedAt?: string;
    sourceMessageIsLatestAssistant?: boolean;
    subagent?: { chatId?: string } | null;
  },
  childStatus?: string,
  toolRunning?: (status?: string) => boolean,
) {
  if (isChildRunLive(childStatus)) return true;
  if (childStatus && !isChildRunLive(childStatus)) return false;
  if (toolRunning?.(tool.status) || ["running", "in_progress", "pending"].includes(String(tool.status || "").toLowerCase())) {
    return true;
  }
  if (!tool.subagent?.chatId) return false;
  const createdAt = Date.parse(tool.sourceMessageCreatedAt || "");
  const stale =
    !tool.sourceMessageIsLatestAssistant &&
    Number.isFinite(createdAt) &&
    Date.now() - createdAt > 15 * 60_000;
  return !stale;
}
