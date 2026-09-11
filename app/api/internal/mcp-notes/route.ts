import { getChat, getGlobalModelSettings } from "@/lib/db-store";
import { internalRunLeaseAuthorized } from "@/lib/internal-run-lease";
import { bearerTokenMatches } from "@/lib/security";
import { featureFlags } from "@/lib/feature-flags";
import {
  createNote,
  listNotes,
  NoteConflictError,
  updateNote,
} from "@/lib/shared-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request) {
  return bearerTokenMatches(req, process.env.MCP_BEARER_TOKEN);
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ ok: true, service: "notes" });
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (req.headers.get("x-ai-chat-incognito") === "1") {
    return Response.json({ error: "Notes are unavailable in Incognito." }, { status: 403 });
  }
  const chatId = req.headers.get("x-ai-chat-id")?.trim() || "";
  const userId = req.headers.get("x-ai-chat-user-id")?.trim() || undefined;
  const jobId = req.headers.get("x-ai-chat-job-id")?.trim() || "";
  const chat = chatId ? getChat(chatId, userId) : null;
  if (!chat || !jobId) return Response.json({ error: "Invalid chat context" }, { status: 400 });
  if (!internalRunLeaseAuthorized(req, jobId)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!featureFlags(getGlobalModelSettings(userId)).notes) return Response.json({ error: "Notes are disabled" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action === "search" ? "search" : body.action === "create" ? "create" : body.action === "update" ? "update" : "list";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : undefined;
  if (workspaceId && !chat.workspaces?.some((workspace) => workspace.id === workspaceId)) {
    return Response.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (action === "list" || action === "search") {
    return Response.json({
      notes: listNotes({
        ownerId: userId,
        chatId,
        workspaceId,
        scope: body.scope === "global" || body.scope === "chat" || body.scope === "workspace" ? body.scope : undefined,
        search: action === "search" && typeof body.query === "string" ? body.query : undefined,
        includeArchived: body.includeArchived === true,
      }),
    });
  }
  if (action === "update") {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return Response.json({ error: "id is required" }, { status: 400 });
    try {
      const note = updateNote(id, {
        ownerId: userId,
        author: "agent",
        title: typeof body.title === "string" ? body.title : undefined,
        content: typeof body.content === "string" ? body.content : undefined,
        kind: body.kind === "project" || body.kind === "note" ? body.kind : undefined,
        todos: Array.isArray(body.todos) ? body.todos as import("@/lib/store").NoteTodo[] : undefined,
        color: typeof body.color === "string" ? body.color : undefined,
        position: body.position && typeof body.position === "object" ? body.position as { x?: number; y?: number } : undefined,
        size: body.size && typeof body.size === "object" ? body.size as { width?: number; height?: number } : undefined,
        archived: typeof body.archived === "boolean" ? body.archived : undefined,
        expectedVersion: typeof body.version === "number" ? Math.floor(body.version) : undefined,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : `${jobId}:${id}`,
      });
      if (!note) return Response.json({ error: "Note not found" }, { status: 404 });
      return Response.json({ note, actor: "agent", jobId });
    } catch (error) {
      if (error instanceof NoteConflictError) return Response.json({ error: error.message, note: error.current }, { status: 409 });
      return Response.json({ error: error instanceof Error ? error.message : "Could not update note" }, { status: 400 });
    }
  }
  const note = createNote({
    ownerId: userId,
    author: "agent",
    chatId,
    workspaceId,
    projectId: typeof body.projectId === "string" ? body.projectId.trim() : chat.projectId,
    scope: body.scope === "global" || body.scope === "workspace" ? body.scope : "chat",
    kind: body.kind === "project" ? "project" : "note",
    todos: Array.isArray(body.todos) ? body.todos as import("@/lib/store").NoteTodo[] : undefined,
    title: typeof body.title === "string" ? body.title : body.kind === "project" ? "Agent project" : "Agent note",
    content: typeof body.content === "string" ? body.content : "",
    color: typeof body.color === "string" ? body.color : undefined,
    position: body.position && typeof body.position === "object" ? body.position as { x?: number; y?: number } : undefined,
    size: body.size && typeof body.size === "object" ? body.size as { width?: number; height?: number } : undefined,
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : `${jobId}:${Date.now()}`,
  });
  return Response.json({ note, actor: "agent", jobId }, { status: 201 });
}
