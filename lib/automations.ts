import { randomUUID } from "node:crypto";
import { getDatabase, transaction } from "@/lib/sqlite";
import { appendMessage, createChat, deleteChat, getChat, saveChat } from "@/lib/db-store";
import { enqueueJob, getJob } from "@/lib/db-jobs";
import { getProject } from "@/lib/projects";

export const MAX_ACTIVE_AUTOMATIONS = 20;
export const MIN_AUTOMATION_INTERVAL_MINUTES = 60;
export const DEFAULT_AUTOMATION_MAX_RUN_MINUTES = 24 * 60;
export const MAX_AUTOMATION_MAX_RUN_MINUTES = 7 * 24 * 60;

export type AutomationStatus = "active" | "paused" | "completed" | "error";
export type AutomationCreator = "user" | "agent";
export type AutomationSchedule =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMinutes: number }
  | { kind: "days"; everyDays: number }
  | { kind: "monthly"; dayOfMonth: number };

export type AutomationGraphNode = {
  id: string;
  kind: "trigger" | "agent" | "tools";
  label: string;
  x: number;
  y: number;
  config?: Record<string, unknown>;
};

export type AutomationGraphEdge = {
  id: string;
  source: string;
  target: string;
};

export type AutomationGraph = {
  version: 1;
  nodes: AutomationGraphNode[];
  edges: AutomationGraphEdge[];
};

export type Automation = {
  id: string;
  ownerId: string;
  /** Context/source chat selected when the automation is created. Runs use their own chats. */
  chatId: string;
  chatTitle?: string;
  projectId?: string | null;
  name: string;
  prompt: string;
  creator: AutomationCreator;
  modeId?: string;
  modelId?: string;
  extendedModelId?: string;
  maxRunMinutes: number;
  graph: AutomationGraph;
  schedule: AutomationSchedule;
  timezone: string;
  status: AutomationStatus;
  nextRunAt?: string;
  lastRunAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  runs?: AutomationRun[];
};

export type AutomationRun = {
  id: string;
  automationId: string;
  jobId?: string;
  chatId: string;
  trigger: "scheduled" | "manual";
  status: "queued" | "running" | "completed" | "error" | "cancelled";
  startedAt?: string;
  completedAt?: string;
  resultPreview?: string;
  error?: string;
  createdAt: string;
  manual?: boolean;
};

type AutomationRow = {
  id: string;
  owner_id: string;
  chat_id: string;
  chat_title?: string;
  project_id?: string | null;
  name: string;
  prompt: string;
  creator?: AutomationCreator | null;
  mode_id: string | null;
  model_id: string | null;
  extended_model_id: string | null;
  max_run_minutes?: number | null;
  graph_json?: string | null;
  schedule_kind: "once" | "interval";
  schedule_value: string;
  timezone: string;
  status: AutomationStatus;
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

const iso = () => new Date().toISOString();

function scheduleLabel(schedule: AutomationSchedule) {
  if (schedule.kind === "once") return "One-time";
  if (schedule.kind === "days") return `Every ${schedule.everyDays} day${schedule.everyDays === 1 ? "" : "s"}`;
  if (schedule.kind === "monthly") return `Monthly · day ${schedule.dayOfMonth}`;
  return `Every ${schedule.everyMinutes} min`;
}

function defaultGraph(input: {
  schedule: AutomationSchedule;
  prompt: string;
  modeId?: string;
  modelId?: string;
  extendedModelId?: string;
  maxRunMinutes: number;
}): AutomationGraph {
  return {
    version: 1,
    nodes: [
      {
        id: "trigger",
        kind: "trigger",
        label: "Trigger",
        x: 24,
        y: 56,
        config: { schedule: input.schedule, summary: scheduleLabel(input.schedule) },
      },
      {
        id: "agent",
        kind: "agent",
        label: "Agent",
        x: 216,
        y: 56,
        config: {
          prompt: input.prompt,
          modeId: input.modeId || "agent",
          modelId: input.modelId,
          extendedModelId: input.extendedModelId,
          maxRunMinutes: input.maxRunMinutes,
        },
      },
      {
        id: "tools",
        kind: "tools",
        label: "Tools & MCPs",
        x: 408,
        y: 56,
        config: { mcp: "all", browser: true, persistentBrowser: true },
      },
    ],
    edges: [
      { id: "trigger-agent", source: "trigger", target: "agent" },
      { id: "agent-tools", source: "agent", target: "tools" },
    ],
  };
}

function normalizeGraph(value: unknown, fallback: AutomationGraph): AutomationGraph {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<AutomationGraph>;
  if (candidate.version !== 1 || !Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) return fallback;
  const nodes = candidate.nodes.flatMap((node) => {
    if (!node || typeof node !== "object") return [];
    const item = node as Partial<AutomationGraphNode>;
    if (!item.id || !item.label || !["trigger", "agent", "tools"].includes(String(item.kind))) return [];
    return [{
      id: String(item.id).slice(0, 100),
      kind: item.kind as AutomationGraphNode["kind"],
      label: String(item.label).slice(0, 120),
      x: Number.isFinite(Number(item.x)) ? Number(item.x) : 0,
      y: Number.isFinite(Number(item.y)) ? Number(item.y) : 0,
      ...(item.config && typeof item.config === "object" ? { config: item.config as Record<string, unknown> } : {}),
    }];
  }).slice(0, 40);
  if (!nodes.length) return fallback;
  const ids = new Set(nodes.map((node) => node.id));
  const edges = candidate.edges.flatMap((edge) => {
    if (!edge || typeof edge !== "object") return [];
    const item = edge as Partial<AutomationGraphEdge>;
    if (!item.id || !item.source || !item.target || !ids.has(String(item.source)) || !ids.has(String(item.target))) return [];
    return [{ id: String(item.id).slice(0, 100), source: String(item.source), target: String(item.target) }];
  }).slice(0, 80);
  return { version: 1, nodes, edges };
}

function scheduleFromStorage(kind: AutomationRow["schedule_kind"], value: string): AutomationSchedule {
  if (kind === "once") return { kind: "once", at: value };
  if (value.startsWith("days:")) return { kind: "days", everyDays: Number(value.slice(5)) };
  if (value.startsWith("monthly:")) return { kind: "monthly", dayOfMonth: Number(value.slice(8)) };
  return { kind: "interval", everyMinutes: Number(value) };
}

function scheduleStorage(schedule: AutomationSchedule): { kind: "once" | "interval"; value: string } {
  if (schedule.kind === "once") return { kind: "once", value: schedule.at };
  if (schedule.kind === "days") return { kind: "interval", value: `days:${schedule.everyDays}` };
  if (schedule.kind === "monthly") return { kind: "interval", value: `monthly:${schedule.dayOfMonth}` };
  return { kind: "interval", value: String(schedule.everyMinutes) };
}

function normalizeMaxRunMinutes(value: unknown) {
  const minutes = Math.floor(Number(value ?? DEFAULT_AUTOMATION_MAX_RUN_MINUTES));
  if (!Number.isFinite(minutes)) return DEFAULT_AUTOMATION_MAX_RUN_MINUTES;
  return Math.max(5, Math.min(minutes, MAX_AUTOMATION_MAX_RUN_MINUTES));
}

function rowToAutomation(row: AutomationRow): Automation {
  const schedule = scheduleFromStorage(row.schedule_kind, row.schedule_value);
  const maxRunMinutes = normalizeMaxRunMinutes(row.max_run_minutes);
  const fallbackGraph = defaultGraph({
    schedule,
    prompt: row.prompt,
    modeId: row.mode_id || undefined,
    modelId: row.model_id || undefined,
    extendedModelId: row.extended_model_id || undefined,
    maxRunMinutes,
  });
  let parsedGraph: unknown;
  try { parsedGraph = row.graph_json ? JSON.parse(row.graph_json) : undefined; } catch { parsedGraph = undefined; }
  return {
    id: row.id,
    ownerId: row.owner_id,
    chatId: row.chat_id,
    ...(row.chat_title ? { chatTitle: row.chat_title } : {}),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    name: row.name,
    prompt: row.prompt,
    creator: row.creator === "agent" ? "agent" : "user",
    ...(row.mode_id ? { modeId: row.mode_id } : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.extended_model_id ? { extendedModelId: row.extended_model_id } : {}),
    maxRunMinutes,
    graph: normalizeGraph(parsedGraph, fallbackGraph),
    schedule,
    timezone: row.timezone,
    status: row.status,
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAutomationRuns(automationId: string, ownerId: string, limit = 50): AutomationRun[] {
  const rows = getDatabase().prepare(
    `SELECT r.id, r.automation_id as automationId, r.job_id as jobId, r.chat_id as chatId,
            r.trigger_type as trigger, r.status, r.started_at as startedAt, r.completed_at as completedAt,
            r.result_preview as resultPreview, r.error, r.created_at as createdAt, r.manual as manual
     FROM automation_runs r
     JOIN automations a ON a.id = r.automation_id
     WHERE r.automation_id = ? AND a.owner_id = ?
     ORDER BY r.created_at DESC LIMIT ?`,
  ).all(automationId, ownerId, Math.max(1, Math.min(limit, 250))) as unknown as Array<AutomationRun & { manual?: number | boolean }>;
  return rows.map((run) => {
    const { manual: manualFlag, ...rest } = run;
    const trigger = rest.trigger === "manual" ? "manual" : "scheduled";
    return {
      ...rest,
      trigger,
      ...(rest.jobId ? { jobId: String(rest.jobId) } : {}),
      ...(rest.resultPreview ? { resultPreview: String(rest.resultPreview) } : {}),
      ...(rest.error ? { error: String(rest.error) } : {}),
      ...(trigger === "manual" || Number(manualFlag) === 1 ? { manual: true } : {}),
    };
  });
}

function validateSchedule(schedule: AutomationSchedule): AutomationSchedule {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    if (!Number.isFinite(at.getTime())) throw new Error("Invalid one-time schedule.");
    if (at.getTime() <= Date.now()) throw new Error("The scheduled time must be in the future.");
    return { kind: "once", at: at.toISOString() };
  }
  if (schedule.kind === "days") {
    const everyDays = Math.floor(Number(schedule.everyDays));
    if (!Number.isFinite(everyDays) || everyDays < 1) throw new Error("The day interval must be at least 1 day.");
    return { kind: "days", everyDays: Math.min(everyDays, 3650) };
  }
  if (schedule.kind === "monthly") {
    const dayOfMonth = Math.floor(Number(schedule.dayOfMonth));
    if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      throw new Error("The day of the month must be between 1 and 31.");
    }
    return { kind: "monthly", dayOfMonth };
  }
  const everyMinutes = Math.floor(Number(schedule.everyMinutes));
  if (!Number.isFinite(everyMinutes) || everyMinutes < MIN_AUTOMATION_INTERVAL_MINUTES) {
    throw new Error(`Recurring automations must run at least every ${MIN_AUTOMATION_INTERVAL_MINUTES} minutes.`);
  }
  return { kind: "interval", everyMinutes: Math.min(everyMinutes, 365 * 24 * 60) };
}

function nextRunFor(schedule: AutomationSchedule, from = Date.now()) {
  if (schedule.kind === "once") return schedule.at;
  if (schedule.kind === "interval") return new Date(from + schedule.everyMinutes * 60_000).toISOString();
  if (schedule.kind === "days") return new Date(from + schedule.everyDays * 24 * 60 * 60_000).toISOString();
  const current = new Date(from);
  const targetDay = schedule.dayOfMonth;
  const candidate = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), targetDay, 0, 0, 0, 0));
  if (candidate.getTime() <= from) candidate.setUTCMonth(candidate.getUTCMonth() + 1, targetDay);
  if (candidate.getUTCDate() !== targetDay) candidate.setUTCDate(0);
  return candidate.toISOString();
}

function activeCount(ownerId: string) {
  return Number((getDatabase().prepare(
    "SELECT COUNT(*) as count FROM automations WHERE owner_id = ? AND status = 'active'",
  ).get(ownerId) as { count?: number }).count || 0);
}

function hasActiveRun(automationId: string) {
  return Boolean(getDatabase().prepare(
    "SELECT 1 as ok FROM automation_runs WHERE automation_id = ? AND status IN ('queued', 'running') LIMIT 1",
  ).get(automationId));
}

function resolvedProjectId(ownerId: string, projectId?: string | null) {
  if (projectId === null) return null;
  const id = typeof projectId === "string" ? projectId.trim() : "";
  if (!id) return undefined;
  return getProject(id, ownerId) ? id : null;
}

export function createAutomation(input: {
  ownerId: string;
  chatId?: string;
  name: string;
  prompt: string;
  creator?: AutomationCreator;
  modeId?: string;
  modelId?: string;
  extendedModelId?: string;
  maxRunMinutes?: number;
  graph?: AutomationGraph;
  schedule: AutomationSchedule;
  timezone?: string;
  projectId?: string | null;
}) {
  const name = input.name.trim().slice(0, 200);
  const prompt = input.prompt.trim().slice(0, 100_000);
  if (!name || !prompt) throw new Error("Automation name and prompt are required.");
  const schedule = validateSchedule(input.schedule);
  if (activeCount(input.ownerId) >= MAX_ACTIVE_AUTOMATIONS) {
    throw new Error(`Maximum ${MAX_ACTIVE_AUTOMATIONS} active automations reached.`);
  }
  const chat = input.chatId ? getChat(input.chatId, input.ownerId) : createChat(`Automation · ${name}`, undefined, input.ownerId);
  if (!chat || chat.incognito) throw new Error("A valid non-incognito context chat is required.");
  const now = iso();
  const id = randomUUID();
  const storedSchedule = scheduleStorage(schedule);
  const maxRunMinutes = normalizeMaxRunMinutes(input.maxRunMinutes);
  const modeId = input.modeId?.trim().slice(0, 100) || "agent";
  const modelId = input.modelId?.trim().slice(0, 300) || null;
  const extendedModelId = input.extendedModelId?.trim().slice(0, 300) || null;
  const fallbackGraph = defaultGraph({
    schedule,
    prompt,
    modeId,
    modelId: modelId || undefined,
    extendedModelId: extendedModelId || undefined,
    maxRunMinutes,
  });
  const graph = normalizeGraph(input.graph, fallbackGraph);
  getDatabase().prepare(
    `INSERT INTO automations
      (id, owner_id, chat_id, project_id, name, prompt, creator, mode_id, model_id, extended_model_id,
       max_run_minutes, graph_json, schedule_kind, schedule_value, timezone, status, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    id,
    input.ownerId,
    chat.id,
      resolvedProjectId(input.ownerId, input.projectId) || null,
    name,
    prompt,
    input.creator === "agent" ? "agent" : "user",
    modeId,
    modelId,
    extendedModelId,
    maxRunMinutes,
    JSON.stringify(graph),
    storedSchedule.kind,
    storedSchedule.value,
    input.timezone?.trim().slice(0, 80) || "UTC",
    schedule.kind === "once" ? schedule.at : nextRunFor(schedule),
    now,
    now,
  );
  return getAutomation(id, input.ownerId)!;
}

export function getAutomation(id: string, ownerId: string, includeRuns = true): Automation | null {
  const row = getDatabase().prepare(
    `SELECT a.*, c.data ->> '$.title' as chat_title
     FROM automations a
     LEFT JOIN chats c ON c.id = a.chat_id
     WHERE a.id = ? AND a.owner_id = ?`,
  ).get(id, ownerId) as AutomationRow | undefined;
  if (!row) return null;
  const automation = rowToAutomation(row);
  return includeRuns ? { ...automation, runs: listAutomationRuns(id, ownerId, 100) } : automation;
}

export function listAutomations(ownerId: string) {
  const rows = getDatabase().prepare(
    `SELECT a.*, c.data ->> '$.title' as chat_title
     FROM automations a
     LEFT JOIN chats c ON c.id = a.chat_id
     WHERE a.owner_id = ?
     ORDER BY CASE a.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
              COALESCE(a.next_run_at, a.updated_at), a.updated_at DESC`,
  ).all(ownerId) as AutomationRow[];
  return rows.map((row) => {
    const automation = rowToAutomation(row);
    return { ...automation, runs: listAutomationRuns(automation.id, ownerId, 6) };
  });
}

export function updateAutomation(
  id: string,
  ownerId: string,
  patch: Partial<Pick<Automation, "name" | "prompt" | "schedule" | "timezone" | "chatId" | "modeId" | "modelId" | "extendedModelId" | "maxRunMinutes" | "graph" | "projectId">>,
) {
  const current = getAutomation(id, ownerId, false);
  if (!current) return null;
  const schedule = patch.schedule ? validateSchedule(patch.schedule) : current.schedule;
  const chat = patch.chatId ? getChat(patch.chatId, ownerId) : getChat(current.chatId, ownerId);
  if (!chat || chat.incognito) throw new Error("A valid non-incognito context chat is required.");
  const now = iso();
  const storedSchedule = scheduleStorage(schedule);
  const nextRunAt = patch.schedule
    ? schedule.kind === "once" ? schedule.at : nextRunFor(schedule)
    : current.nextRunAt || (schedule.kind === "once" ? schedule.at : nextRunFor(schedule));
  const name = patch.name?.trim().slice(0, 200) || current.name;
  const prompt = patch.prompt?.trim().slice(0, 100_000) || current.prompt;
  const modeId = patch.modeId !== undefined ? patch.modeId.trim().slice(0, 100) || "agent" : current.modeId || "agent";
  const modelId = patch.modelId !== undefined ? patch.modelId.trim().slice(0, 300) || null : current.modelId || null;
  const extendedModelId = patch.extendedModelId !== undefined ? patch.extendedModelId.trim().slice(0, 300) || null : current.extendedModelId || null;
  const maxRunMinutes = patch.maxRunMinutes !== undefined ? normalizeMaxRunMinutes(patch.maxRunMinutes) : current.maxRunMinutes;
  const generatedGraph = defaultGraph({
    schedule,
    prompt,
    modeId,
    modelId: modelId || undefined,
    extendedModelId: extendedModelId || undefined,
    maxRunMinutes,
  });
  const graph = patch.graph ? normalizeGraph(patch.graph, generatedGraph) : generatedGraph;
    const projectId = patch.projectId !== undefined
      ? resolvedProjectId(ownerId, patch.projectId) || null
      : current.projectId || null;
  getDatabase().prepare(
    `UPDATE automations SET chat_id = ?, project_id = ?, name = ?, prompt = ?, mode_id = ?, model_id = ?, extended_model_id = ?,
       max_run_minutes = ?, graph_json = ?, schedule_kind = ?, schedule_value = ?, timezone = ?, next_run_at = ?,
       status = CASE WHEN status IN ('completed', 'error') THEN 'active' ELSE status END,
       last_error = NULL, updated_at = ? WHERE id = ? AND owner_id = ?`,
  ).run(
    chat.id,
    projectId,
    name,
    prompt,
    modeId,
    modelId,
    extendedModelId,
    maxRunMinutes,
    JSON.stringify(graph),
    storedSchedule.kind,
    storedSchedule.value,
    patch.timezone?.trim().slice(0, 80) || current.timezone,
    nextRunAt,
    now,
    id,
    ownerId,
  );
  return getAutomation(id, ownerId);
}

export function setAutomationStatus(id: string, ownerId: string, status: "active" | "paused") {
  const current = getAutomation(id, ownerId, false);
  if (!current) return null;
  const nextRunAt = status === "active"
    ? current.nextRunAt || (current.schedule.kind === "once" ? current.schedule.at : nextRunFor(current.schedule))
    : current.nextRunAt;
  getDatabase().prepare(
    "UPDATE automations SET status = ?, next_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND owner_id = ?",
  ).run(status, nextRunAt ?? null, iso(), id, ownerId);
  return getAutomation(id, ownerId);
}

export function deleteAutomation(id: string, ownerId: string) {
  const runChats = transaction(() => {
    const current = getAutomation(id, ownerId, false);
    if (!current) return null;
    if (hasActiveRun(id)) throw new Error("Stop or wait for the active automation run before deleting it.");
    const chats = getDatabase().prepare(
      "SELECT chat_id as chatId FROM automation_runs WHERE automation_id = ?",
    ).all(id) as Array<{ chatId: string }>;
    const deleted = Boolean(getDatabase().prepare(
      "DELETE FROM automations WHERE id = ? AND owner_id = ?",
    ).run(id, ownerId).changes);
    return deleted ? chats : null;
  });
  if (!runChats) return false;
  // Run chats are auxiliary durable transcripts. Delete them after the automation
  // transaction so deleteChat() can use its own transaction safely.
  for (const row of runChats) deleteChat(row.chatId, ownerId);
  return true;
}

export function claimDueAutomations(limit = 10) {
  return transaction(() => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const staleIso = new Date(now - 15 * 60_000).toISOString();
    const rows = getDatabase().prepare(
      `SELECT a.*, c.data ->> '$.title' as chat_title
       FROM automations a
       LEFT JOIN chats c ON c.id = a.chat_id
       WHERE a.status = 'active' AND a.next_run_at IS NOT NULL AND a.next_run_at <= ?
         AND (a.claimed_at IS NULL OR a.claimed_at < ?)
         AND NOT EXISTS (
           SELECT 1 FROM automation_runs r
           WHERE r.automation_id = a.id AND r.status IN ('queued', 'running')
         )
       ORDER BY a.next_run_at ASC LIMIT ?`,
    ).all(nowIso, staleIso, limit) as AutomationRow[];
    const claimed: AutomationRow[] = [];
    for (const row of rows) {
      const result = getDatabase().prepare(
        `UPDATE automations SET claimed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active' AND (claimed_at IS NULL OR claimed_at < ?)`,
      ).run(nowIso, nowIso, row.id, staleIso);
      if (result.changes) claimed.push(row);
    }
    return claimed.map(rowToAutomation);
  });
}

function runTitle(name: string, createdAt: string) {
  const stamp = createdAt.slice(0, 16).replace("T", " ");
  return `${name} · ${stamp}`;
}

export function startAutomationRun(automation: Automation, trigger: AutomationRun["trigger"] = "scheduled") {
  const id = randomUUID();
  const now = iso();
  const sourceChat = getChat(automation.chatId, automation.ownerId);
  if (!sourceChat || sourceChat.incognito) throw new Error("Automation context chat is no longer available.");
  const runChat = createChat(
    runTitle(automation.name, now),
    sourceChat.browserContext ? { ...sourceChat.browserContext } : undefined,
    automation.ownerId,
    automation.modelId ? { id: automation.modelId } : undefined,
  );
  runChat.automationId = automation.id;
  runChat.automationRunId = id;
  runChat.automationName = automation.name;
  runChat.keywords = ["automation", automation.name].filter(Boolean).slice(0, 8);
  saveChat(runChat);
  const messageId = randomUUID();
  appendMessage(runChat.id, {
    id: messageId,
    role: "user",
    content: automation.prompt,
  }, automation.ownerId);
  getDatabase().prepare(
    `INSERT INTO automation_runs (id, automation_id, chat_id, trigger_type, status, created_at, manual)
     VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(id, automation.id, runChat.id, trigger, now, trigger === "manual" ? 1 : 0);
  return { id, chatId: runChat.id, messageId };
}

export function linkAutomationRunJob(runId: string, jobId: string) {
  getDatabase().prepare(
    "UPDATE automation_runs SET job_id = ?, status = 'running', started_at = ? WHERE id = ?",
  ).run(jobId, iso(), runId);
}

function automationExecutionContext(automation: Automation) {
  const source = getChat(automation.chatId, automation.ownerId);
  const sourceMessages = (source?.messages || [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-24)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content.trim()}`)
    .filter((line) => !line.endsWith(": "));
  const recentRuns = listAutomationRuns(automation.id, automation.ownerId, 5)
    .filter((run) => run.status === "completed" && run.resultPreview)
    .reverse()
    .map((run) => `${run.completedAt || run.createdAt}: ${run.resultPreview}`);
  const parts = [
    sourceMessages.length ? `Source chat context (${source?.title || "context chat"}):\n${sourceMessages.join("\n\n")}` : "",
    recentRuns.length ? `Recent completed automation results:\n${recentRuns.join("\n")}` : "",
  ].filter(Boolean);
  const text = parts.join("\n\n");
  return text.length > 40_000 ? text.slice(-40_000) : text;
}

export function queueAutomationRun(automation: Automation, trigger: AutomationRun["trigger"] = "scheduled") {
  if (hasActiveRun(automation.id)) throw new Error("This automation already has an active run.");
  const run = startAutomationRun(automation, trigger);
  try {
    const job = enqueueJob({
      chatId: run.chatId,
      userId: automation.ownerId,
      message: automation.prompt,
      messageId: run.messageId,
      modeId: automation.modeId || "agent",
      ...(automation.modelId ? { modelId: automation.modelId } : {}),
      ...(automation.extendedModelId ? { extendedModelId: automation.extendedModelId } : {}),
      maxRuntimeMs: automation.maxRunMinutes * 60_000,
      automationId: automation.id,
      automationRunId: run.id,
      automationContext: automationExecutionContext(automation),
    });
    linkAutomationRunJob(run.id, job.id);
    return { run: { ...run, jobId: job.id }, job };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not enqueue automation run.";
    getDatabase().prepare(
      "UPDATE automation_runs SET status = 'error', completed_at = ?, error = ? WHERE id = ?",
    ).run(iso(), message.slice(0, 2_000), run.id);
    throw error;
  }
}

export function runAutomationNow(id: string, ownerId: string) {
  const automation = getAutomation(id, ownerId, false);
  if (!automation) return null;
  if (hasActiveRun(id)) throw new Error("This automation already has an active run.");
  getDatabase().prepare(
    "UPDATE automations SET claimed_at = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
  ).run(iso(), iso(), id, ownerId);
  try {
    const queued = queueAutomationRun(automation, "manual");
    return { automation: getAutomation(id, ownerId), ...queued };
  } catch (error) {
    getDatabase().prepare(
      "UPDATE automations SET claimed_at = NULL, updated_at = ? WHERE id = ? AND owner_id = ?",
    ).run(iso(), id, ownerId);
    throw error;
  }
}

export function failAutomationClaim(id: string, ownerId: string, error: string) {
  const current = getAutomation(id, ownerId, false);
  if (!current) return;
  const recurring = current.schedule.kind !== "once";
  getDatabase().prepare(
    `UPDATE automations SET status = ?, next_run_at = ?, last_error = ?, claimed_at = NULL, updated_at = ?
     WHERE id = ? AND owner_id = ?`,
  ).run(
    recurring ? "active" : "error",
    recurring ? nextRunFor(current.schedule) : null,
    error.slice(0, 2_000),
    iso(),
    id,
    ownerId,
  );
}

function resultPreviewForChat(chatId: string, ownerId: string) {
  const chat = getChat(chatId, ownerId);
  const message = [...(chat?.messages || [])].reverse().find((item) => item.role === "assistant");
  const text = message?.content?.trim() || message?.errorMessage?.trim() || "";
  return text ? text.replace(/\s+/g, " ").slice(0, 320) : undefined;
}

export function finalizeAutomationRunForJob(jobId: string) {
  const job = getJob(jobId);
  if (!job?.automationId || !job.automationRunId) return;
  if (!["completed", "cancelled", "error", "interrupted"].includes(job.status)) return;
  const row = getDatabase().prepare(
    `SELECT r.id, r.automation_id as automationId, r.chat_id as chatId, r.trigger_type as triggerType,
            a.chat_id as contextChatId, a.owner_id as ownerId, a.status as automationStatus, a.schedule_kind as scheduleKind,
            a.schedule_value as scheduleValue, a.next_run_at as nextRunAt
     FROM automation_runs r JOIN automations a ON a.id = r.automation_id
     WHERE r.id = ? AND r.job_id = ?`,
  ).get(job.automationRunId, jobId) as {
    id: string;
    automationId: string;
    chatId: string;
    triggerType: "scheduled" | "manual";
    contextChatId: string;
    ownerId: string;
    automationStatus: AutomationStatus;
    scheduleKind: "once" | "interval";
    scheduleValue: string;
    nextRunAt: string | null;
  } | undefined;
  if (!row) return;
  const completed = job.status === "completed";
  const runStatus = completed ? "completed" : job.status === "cancelled" ? "cancelled" : "error";
  const now = iso();
  const error = job.error?.slice(0, 2_000);
  const runChat = getChat(row.chatId, row.ownerId);
  const preview = completed ? resultPreviewForChat(row.chatId, row.ownerId) || "Automation run completed." : undefined;
  // Carry the shared browser session/tabs forward without merging run messages into
  // the context chat. The next isolated run therefore continues the same durable
  // browser session while run transcripts remain completely separate.
  if (runChat?.browserContext) {
    const contextChat = getChat(row.contextChatId, row.ownerId);
    if (contextChat) {
      contextChat.browserContext = { ...runChat.browserContext, updatedAt: now };
      saveChat(contextChat);
    }
  }
  getDatabase().prepare(
    "UPDATE automation_runs SET status = ?, completed_at = ?, error = ?, result_preview = ? WHERE id = ?",
  ).run(runStatus, now, error || null, preview || null, row.id);

  const storedSchedule = scheduleFromStorage(row.scheduleKind, row.scheduleValue);
  const recurring = storedSchedule.kind !== "once";
  let next: string | null = null;
  if (recurring) {
    if (row.triggerType === "manual" && row.nextRunAt && Date.parse(row.nextRunAt) > Date.now()) next = row.nextRunAt;
    else next = nextRunFor(storedSchedule);
  }
  const nextStatus: AutomationStatus = row.automationStatus === "paused"
    ? "paused"
    : recurring
      ? "active"
      : completed
        ? "completed"
        : "error";
  getDatabase().prepare(
    `UPDATE automations SET status = ?, next_run_at = ?, last_run_at = ?, last_error = ?,
       claimed_at = NULL, updated_at = ? WHERE id = ? AND owner_id = ?`,
  ).run(
    nextStatus,
    next,
    now,
    error || null,
    now,
    row.automationId,
    row.ownerId,
  );
}
