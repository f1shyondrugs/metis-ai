import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import { requestClientAddress } from "@/lib/rate-limit";
import {
  isErrorLogLevel,
  isErrorLogSource,
  logError,
  queryErrorLogs,
  type ErrorLogEntry,
} from "@/lib/error-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT_PER_MINUTE = 60;
const MAX_BATCH = 25;

type Limiter = { count: number; resetAt: number };
const globalStore = globalThis as typeof globalThis & {
  __metisErrorLogRate?: Map<string, Limiter>;
};
const rateBuckets = (globalStore.__metisErrorLogRate ??= new Map<
  string,
  Limiter
>());

function rateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_PER_MINUTE;
}

function clientKey(req: Request, userId: string) {
  return userId || requestClientAddress(req) || "anonymous";
}

function validateEntry(
  value: unknown,
  userId: string,
): Omit<ErrorLogEntry, "userId"> | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const level = entry.level;
  const source = entry.source;
  if (!isErrorLogLevel(level)) return null;
  if (!isErrorLogSource(source)) return null;
  if (typeof entry.message !== "string" || !entry.message.trim()) return null;
  if (entry.message.length > 8_192) return null;
  if (entry.stack !== undefined && typeof entry.stack !== "string") return null;
  if (
    entry.context !== undefined &&
    (typeof entry.context !== "object" ||
      entry.context === null ||
      Array.isArray(entry.context))
  )
    return null;
  return {
    level,
    source,
    message: entry.message,
    ...(typeof entry.stack === "string"
      ? { stack: entry.stack.slice(0, 16_384) }
      : {}),
    ...(entry.context
      ? { context: entry.context as Record<string, unknown> }
      : {}),
    ...(typeof entry.ts === "number" &&
    Number.isFinite(entry.ts) &&
    entry.ts > 0
      ? { ts: entry.ts }
      : {}),
  };
}

export async function POST(req: Request) {
  if (!(await isAuthenticated(req))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (await getAuthenticatedUserId(req)) ?? "";
  if (!rateLimit(clientKey(req, userId))) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const body = (await req.json().catch(() => ({}))) as { entries?: unknown };
  if (
    !Array.isArray(body.entries) ||
    !body.entries.length ||
    body.entries.length > MAX_BATCH
  ) {
    return Response.json(
      { error: "entries must be an array of 1-25 items" },
      { status: 400 },
    );
  }
  const entries: ErrorLogEntry[] = [];
  for (const candidate of body.entries) {
    const entry = validateEntry(candidate, userId);
    if (!entry)
      return Response.json({ error: "Invalid entry" }, { status: 400 });
    entries.push({ ...entry, userId: userId || undefined });
  }
  let inserted = 0;
  for (const entry of entries) {
    if (logError(entry)) inserted += 1;
  }
  // Never echo submitted stack details back in the response.
  return Response.json(
    { ok: true, inserted },
    { status: inserted ? 202 : 200 },
  );
}

export async function GET(req: Request) {
  if (!(await isAuthenticated(req))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = await getAuthenticatedUserId(req);
  const params = new URL(req.url).searchParams;
  const source = params.get("source") ?? undefined;
  const level = params.get("level") ?? undefined;
  const sinceParam = Number(params.get("since") || "0");
  const limitParam = Number(params.get("limit") || "100");
  if (source && !isErrorLogSource(source)) {
    return Response.json({ error: "Invalid source" }, { status: 400 });
  }
  if (level && !isErrorLogLevel(level)) {
    return Response.json({ error: "Invalid level" }, { status: 400 });
  }
  const logs = queryErrorLogs({
    ...(Number.isFinite(sinceParam) && sinceParam > 0
      ? { since: sinceParam }
      : {}),
    ...(source && isErrorLogSource(source) ? { source } : {}),
    ...(level && isErrorLogLevel(level) ? { level } : {}),
    ...(Number.isFinite(limitParam) ? { limit: limitParam } : {}),
  });
  // Owner scope: the signed-in user's logs plus anonymous system/server logs.
  return Response.json({
    logs: logs.filter((log) => !log.userId || !userId || log.userId === userId),
  });
}
