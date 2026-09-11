import { runAgentTimedWait } from "@/lib/agent-wait";
import { internalRunLeaseAuthorized } from "@/lib/internal-run-lease";
import { getChat } from "@/lib/db-store";
import { bearerTokenMatches } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 960;

const PRESETS: Record<string, number> = {
  "60s": 60_000,
  "5m": 5 * 60_000,
};
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 15 * 60_000;

function parseDuration(input: unknown, durationMs: unknown) {
  if (typeof input === "string" && PRESETS[input]) return PRESETS[input];
  if (input === "custom" && typeof durationMs === "number" && Number.isFinite(durationMs)) {
    return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.floor(durationMs)));
  }
  throw new Error("duration must be 60s, 5m, or custom with durationMs");
}

export async function POST(req: Request) {
  if (!bearerTokenMatches(req, process.env.MCP_BEARER_TOKEN)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const chatId = req.headers.get("x-ai-chat-id")?.trim() || "";
  const userId = req.headers.get("x-ai-chat-user-id")?.trim() || undefined;
  const jobId = req.headers.get("x-ai-chat-job-id")?.trim() || "";
  const chat = chatId ? getChat(chatId, userId) : null;
  if (!chat || !jobId) return Response.json({ error: "Invalid chat context" }, { status: 400 });
  if (!internalRunLeaseAuthorized(req, jobId)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    duration?: unknown;
    durationMs?: unknown;
    reason?: unknown;
  };
  let waitMs: number;
  try {
    waitMs = parseDuration(body.duration, body.durationMs);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid duration" }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : undefined;
  try {
    const result = await runAgentTimedWait({
      jobId,
      chatId,
      userId,
      waitMs,
      reason,
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The agent wait was cancelled." },
      { status: 409 },
    );
  }
}
