import { getAuthenticatedUser } from "@/lib/auth";
import {
  deleteChat,
  getChatPage,
  updateChat,
  type BrowserContext,
  type PendingChatQuestion,
  type WorkspaceItem,
} from "@/lib/db-store";
import type { ChatSessionState } from "@/lib/store";
import type { ChatBadge } from "@/lib/store";
import { requestJobModelSwitch } from "@/lib/db-jobs";
import { isModelAllowed } from "@/lib/model-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const ownerId = user.id;
  const searchParams = new URL(req.url).searchParams;
  const requestedLimit = Number(searchParams.get("messageLimit") || "10");
  const requestedOffset = Number(searchParams.get("messageOffset") || "0");
  const messageLimit = Number.isFinite(requestedLimit)
    ? Math.min(100, Math.max(1, Math.floor(requestedLimit)))
    : 10;
  const messageOffset = Number.isFinite(requestedOffset)
    ? Math.max(0, Math.floor(requestedOffset))
    : 0;
  const page = getChatPage(id, ownerId, messageLimit, messageOffset);
  if (!page) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(page);
}

export async function PATCH(req: Request, { params }: Params) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const ownerId = user.id;
  let body: {
    title?: string;
    titleSource?: "default" | "user" | "agent";
    keywords?: string[] | null;
    agentId?: string | null;
    modelId?: string | null;
    modelParams?: Array<{ id: string; value: string }> | null;
    queuedMessages?: Array<{ id: string; text: string }> | null;
    pinned?: boolean;
    archived?: boolean;
    canvas?: string | null;
    workspaces?: WorkspaceItem[] | null;
    browserContext?: BrowserContext | null;
    sessionState?: ChatSessionState | null;
    pendingQuestion?: PendingChatQuestion | null;
    runtimeMode?: string | null;
    badge?: ChatBadge | null;
    touchUpdatedAt?: boolean;
    projectId?: string | null;
  };
  try {
    body = (await req.json()) as {
      title?: string;
      titleSource?: "default" | "user" | "agent";
      keywords?: string[] | null;
      agentId?: string | null;
      modelId?: string | null;
      modelParams?: Array<{ id: string; value: string }> | null;
      queuedMessages?: Array<{ id: string; text: string }> | null;
      pinned?: boolean;
      archived?: boolean;
      canvas?: string | null;
      workspaces?: WorkspaceItem[] | null;
      browserContext?: BrowserContext | null;
      sessionState?: ChatSessionState | null;
      pendingQuestion?: PendingChatQuestion | null;
      runtimeMode?: string | null;
      badge?: ChatBadge | null;
      touchUpdatedAt?: boolean;
      projectId?: string | null;
    };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const requestedModelId =
    typeof body.modelId === "string" ? body.modelId.trim() : "";
  if (requestedModelId && !isModelAllowed(ownerId, requestedModelId)) {
    return Response.json(
      { error: "This model is not available for your account" },
      { status: 403 },
    );
  }

  let chat;
  try {
    chat = updateChat(
      id,
      {
        ...body,
        pendingApproval: undefined,
        approvedPatterns: undefined,
        // PATCH is used for UI/session metadata. Only message writes should
        // move a chat in the activity-sorted sidebar.
        touchUpdatedAt: body.touchUpdatedAt === true,
      },
      ownerId,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "WorkspaceNameConflict") {
      return Response.json(
        { error: "A plan with this name already exists" },
        { status: 409 },
      );
    }
    throw error;
  }
  if (!chat) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const modelSwitch = requestedModelId
    ? requestJobModelSwitch(
        id,
        ownerId,
        requestedModelId,
        body.modelParams || undefined,
      )
    : null;
  // Metadata/session PATCHes do not need to send the complete transcript back
  // to the browser. Large chats can contain several megabytes of messages,
  // and returning them here multiplies the cost of otherwise tiny autosaves.
  return Response.json({
    chat: {
      ...chat,
      messages: [],
    },
    ...(modelSwitch?.pendingModelId
      ? {
          modelSwitch: {
            requested: true,
            jobId: modelSwitch.id,
            modelId: modelSwitch.pendingModelId,
          },
        }
      : {}),
  });
}

export async function DELETE(req: Request, { params }: Params) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const ownerId = user.id;
  if (!deleteChat(id, ownerId)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
