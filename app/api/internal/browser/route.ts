import { passwordMatches } from "@/lib/auth";
import { internalRunLeaseAuthorized } from "@/lib/internal-run-lease";
import { bearerTokenMatches } from "@/lib/security";
import { performSharedBrowserAction } from "@/lib/shared-browser-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function internalAuthorized(req: Request) {
  const configured = process.env.AI_CHAT_INTERNAL_TOKEN?.trim() || process.env.MCP_BEARER_TOKEN?.trim();
  if (configured) return bearerTokenMatches(req, configured);
  return req.headers.get("x-ai-chat-internal") === "1" && passwordMatches(req.headers.get("x-chat-password"));
}

export async function POST(req: Request) {
  if (!internalAuthorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const jobId = req.headers.get("x-ai-chat-job-id")?.trim() || "";
  if (jobId && !internalRunLeaseAuthorized(req, jobId)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const chatId = req.headers.get("x-ai-chat-id")?.trim();
  const userId = req.headers.get("x-ai-chat-user-id")?.trim();
  if (!chatId || !userId) return Response.json({ error: "Chat and user context are required" }, { status: 400 });
  try {
    const body = (await req.json()) as { action?: string; [key: string]: unknown };
    if (!body.action) return Response.json({ error: "Browser action is required" }, { status: 400 });
    const result = await performSharedBrowserAction(userId, chatId, { ...body, action: body.action, source: "agent" });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Browser action failed" }, { status: 400 });
  }
}
