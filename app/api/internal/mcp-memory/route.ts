import { createMemory, deleteMemory, listMemories, updateMemory } from "@/lib/db-store";
import { internalRunLeaseAuthorized } from "@/lib/internal-run-lease";
import { bearerTokenMatches } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request) {
  return bearerTokenMatches(req, process.env.MCP_BEARER_TOKEN);
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const jobId = req.headers.get("x-ai-chat-job-id")?.trim() || "";
  if (jobId && !internalRunLeaseAuthorized(req, jobId)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const userId = req.headers.get("x-ai-chat-user-id")?.trim() || undefined;
  if (req.headers.get("x-ai-chat-incognito") === "1") {
    return Response.json({ error: "Memory tools are unavailable in Incognito." }, { status: 403 });
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "list";

  if (action === "list") {
    return Response.json({ memories: listMemories(userId) });
  }
  if (action === "add") {
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) return Response.json({ error: "content is required" }, { status: 400 });
    return Response.json({ memory: createMemory(content, Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined, userId) });
  }
  if (action === "edit") {
    const id = typeof body.id === "string" ? body.id : "";
    const content = typeof body.content === "string" ? body.content.trim() : undefined;
    const memory = updateMemory(id, {
      ...(content ? { content } : {}),
      ...(Array.isArray(body.tags) ? { tags: body.tags.filter((tag): tag is string => typeof tag === "string") } : {}),
    }, userId);
    if (!memory) return Response.json({ error: "Memory not found" }, { status: 404 });
    return Response.json({ memory });
  }
  if (action === "delete") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!deleteMemory(id, userId)) return Response.json({ error: "Memory not found" }, { status: 404 });
    return Response.json({ ok: true, id });
  }
  return Response.json({ error: "Unknown memory action" }, { status: 400 });
}
