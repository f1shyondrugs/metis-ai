import { getGlobalModelSettings } from "@/lib/db-store";
import { internalRunLeaseAuthorized } from "@/lib/internal-run-lease";
import { getChat, updateChat } from "@/lib/db-store";
import { modeById } from "@/lib/modes";
import { bearerTokenMatches } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!bearerTokenMatches(req, process.env.MCP_BEARER_TOKEN)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const jobId = req.headers.get("x-ai-chat-job-id")?.trim() || "";
  if (jobId && !internalRunLeaseAuthorized(req, jobId)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const chatId = req.headers.get("x-ai-chat-id")?.trim() || "";
  const userId = req.headers.get("x-ai-chat-user-id")?.trim() || "";
  if (!chatId || !userId) return Response.json({ error: "Chat context is required" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { modeId?: unknown };
  const modeId = typeof body.modeId === "string" ? body.modeId.trim() : "";
  const mode = modeById(modeId, getGlobalModelSettings(userId).customModes || []);
  if (!mode || mode.id !== modeId) return Response.json({ error: "Unknown mode" }, { status: 400 });
  const chat = getChat(chatId, userId);
  if (!chat) return Response.json({ error: "Chat not found" }, { status: 404 });
  const updated = updateChat(chatId, { sessionState: { ...(chat.sessionState || {}), modeId: mode.id } }, userId);
  return Response.json({ mode, chat: updated ? { id: updated.id, modeId: mode.id } : null });
}
