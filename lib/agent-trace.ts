import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import type { AgentJob } from "@/lib/jobs";

const SECRET_KEY = /(?:api[_-]?key|authorization|bearer|password|secret|token|credential|cookie)/i;
const SECRET_VALUE = /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|\b(?:sk-[a-zA-Z0-9_-]{8,}|Bearer\s+\S+|ghp_[a-zA-Z0-9]{20,}|xox[baprs]-[a-zA-Z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b|\b[a-f0-9]{32,}\b|\b(?=[a-zA-Z0-9+/_-]{40,}\b)(?=[a-zA-Z0-9+/_-]*[A-Z])(?=[a-zA-Z0-9+/_-]*[a-z])(?=[a-zA-Z0-9+/_-]*[0-9])[a-zA-Z0-9+/_-]{40,}={0,2})/gi;
const MAX_STRING = 8_000;
const MAX_DEPTH = 6;
const TRACE_RETENTION_DAYS = 14;
const TRACE_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;
const TRACE_RETENTION_BATCH_SIZE = 32;
let lastTraceRetentionAt = 0;

export function agentTraceDir(job?: Pick<AgentJob, "id" | "createdAt">) {
  const day = (job?.createdAt || new Date().toISOString()).slice(0, 10);
  return path.join(config.dataDir, "agent-traces", day);
}

export function agentTracePath(job: Pick<AgentJob, "id" | "createdAt">) {
  return path.join(agentTraceDir(job), `${job.id}.jsonl`);
}

function redactString(value: string, maxString: number) {
  const bounded = value.length <= maxString
    ? value
    : `${value.slice(0, maxString)}…[truncated ${value.length - maxString} chars]`;
  return bounded.replace(SECRET_VALUE, "[redacted]");
}

export function redactSensitiveData(value: unknown, maxString = MAX_STRING, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactString(value, maxString);
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactSensitiveData(item, maxString, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY.test(key) ? "[redacted]" : redactSensitiveData(nested, maxString, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function redactTraceValue(value: unknown, depth = 0): unknown {
  return redactSensitiveData(value, MAX_STRING, depth);
}

function cleanupOldTraceDays(now = Date.now()) {
  if (now - lastTraceRetentionAt < TRACE_RETENTION_INTERVAL_MS) return;
  lastTraceRetentionAt = now;
  const root = path.join(config.dataDir, "agent-traces");
  const cutoff = now - TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  let removed = 0;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (removed >= TRACE_RETENTION_BATCH_SIZE || !entry.isDirectory()) continue;
      const entryPath = path.join(root, entry.name);
      const namedDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry.name);
      const age = namedDay ? Date.parse(`${entry.name}T00:00:00.000Z`) : statSync(entryPath).mtimeMs;
      if (Number.isFinite(age) && age < cutoff) {
        rmSync(entryPath, { recursive: true, force: true });
        removed += 1;
      }
    }
  } catch (error) {
    console.warn("[agent-trace] retention cleanup failed", error);
  }
}

export function summarizeTraceData(event: string, data: unknown) {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  if (event === "text" && typeof record.text === "string") {
    return {
      chars: record.text.length,
      tail: redactString(record.text.slice(-400), MAX_STRING),
    };
  }
  return redactTraceValue(data);
}

export function appendAgentTrace(
  job: Pick<AgentJob, "id" | "chatId" | "userId" | "createdAt" | "modelId" | "modeId">,
  event: string,
  data?: unknown,
) {
  const row = {
    t: new Date().toISOString(),
    jobId: job.id,
    chatId: job.chatId,
    event,
    data: summarizeTraceData(event, data),
  };
  const line = `${JSON.stringify(row)}\n`;
  cleanupOldTraceDays();
  try {
    mkdirSync(agentTraceDir(job), { recursive: true });
    appendFileSync(agentTracePath(job), line, "utf8");
  } catch (error) {
    console.error("[agent-trace] write failed", error);
  }
  if (event !== "text") {
    const extra = event === "tool" && data && typeof data === "object"
      ? ` ${(data as { name?: string; status?: string }).name || ""} ${(data as { status?: string }).status || ""}`.trim()
      : "";
    console.log(`[agent-trace] ${job.id.slice(0, 8)} ${event}${extra ? ` ${extra}` : ""}`);
  }
}
