import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import { requestJobCancel } from "@/lib/db-jobs";
import { getAgentCwd } from "@/lib/mcp";
import { revertMessages } from "@/lib/revert";
import { getChat, saveChat } from "@/lib/db-store";
import { revertChatNotes } from "@/lib/shared-context";
import { hydrateToolsForRevert } from "@/lib/tool-persistence";
import { withoutProviderSessionBindings } from "@/lib/providers/session-bindings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  if (!(await isAuthenticated(req))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const ownerId = await getAuthenticatedUserId(req) ?? undefined;
  const chat = getChat(id, ownerId);
  if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
  requestJobCancel(id, ownerId);

  let body: { messageId?: string; keepMessage?: boolean };
  try {
    body = (await req.json()) as { messageId?: string; keepMessage?: boolean };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.messageId || typeof body.messageId !== "string") {
    return Response.json({ error: "messageId is required" }, { status: 400 });
  }

  const index = chat.messages.findIndex((message) => message.id === body.messageId);
  if (index < 0) return Response.json({ error: "Message not found" }, { status: 404 });

  const rollbackStart = body.keepMessage === true ? index + 1 : index;
  const messagesForRevert = chat.messages.map((message) => ({
    ...message,
    tools: hydrateToolsForRevert(id, message.id, message.tools),
  }));
  const result = revertMessages(messagesForRevert, rollbackStart, getAgentCwd(ownerId));
  const revertedNotes = revertChatNotes(id, ownerId, chat.messages[index].createdAt);
  chat.messages = chat.messages.slice(0, body.keepMessage === true ? index + 1 : index);

  // A visual transcript revert is not enough for native providers. Their
  // session cursor still contains the removed turn, so resuming it would put
  // the reverted message straight back into model context. Invalidate every
  // native continuation and let the next run bootstrap from the already-trimmed
  // durable Metis history instead.
  delete chat.agentId;
  chat.sessionState = withoutProviderSessionBindings(chat.sessionState);

  // Follow-ups and interactive state created after this point belong to the
  // abandoned branch as well. They must never fire after Retry/Revert.
  delete chat.queuedMessages;
  delete chat.queueMessage;
  delete chat.pendingQuestion;
  delete chat.pendingApproval;

  if (result.canvasUpdated) {
    delete chat.canvas;
    if (chat.workspaces) {
      chat.workspaces = chat.workspaces.filter((workspace) => workspace.type !== "canvas");
    }
  }
  chat.runStatus = "cancelled";
  chat.runUpdatedAt = new Date().toISOString();
  const saved = saveChat(chat);

  return Response.json({
    chat: saved,
    revertedFiles: result.revertedFiles,
    revertedNotes,
    conflicts: result.revertedFiles.filter((file) => file.status === "conflict"),
    nonReversible: {
      count: result.nonReversibleNames.length,
      names: result.nonReversibleNames,
      tools: result.nonReversibleTools,
    },
    warnings: [
      ...result.revertedFiles
        .filter((file) => file.status === "warning")
        .map((file) => `${file.path}: ${file.reason}`),
      ...(result.canvasUpdated
        ? ["Canvas content was cleared because its previous state is not stored."]
        : []),
    ],
  });
}
