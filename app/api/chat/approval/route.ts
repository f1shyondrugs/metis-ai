import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import { resolveApproval } from "@/lib/db-approvals";
import { getChat, updateChat } from "@/lib/db-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DECISIONS = new Set(["allow", "allow-session", "deny"]);

export async function POST(req: Request) {
  if (!(await isAuthenticated(req))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    approvalId?: unknown;
    decision?: unknown;
    version?: unknown;
  };
  const approvalId =
    typeof body.approvalId === "string" ? body.approvalId.trim() : "";
  const decision =
    typeof body.decision === "string" && DECISIONS.has(body.decision)
      ? (body.decision as "allow" | "allow-session" | "deny")
      : "";
  const version =
    typeof body.version === "number" && Number.isFinite(body.version)
      ? Math.floor(body.version)
      : undefined;
  if (!approvalId || !decision) {
    return Response.json(
      { error: "Invalid approval decision" },
      { status: 400 },
    );
  }
  const userId = (await getAuthenticatedUserId(req)) ?? undefined;
  const resolved = resolveApproval(approvalId, decision, userId, version);
  if (!resolved) {
    return Response.json(
      { error: "Approval not found or already resolved" },
      { status: 404 },
    );
  }
  const currentChat = getChat(resolved.chatId, userId);
  if (currentChat?.pendingApproval?.id === approvalId) {
    updateChat(
      resolved.chatId,
      {
        runStatus: "running",
        pendingApproval: null,
        ...(resolved.decision === "allow-session" && resolved.sessionScope
          ? {
              approvedPatterns: [
                ...(currentChat.approvedPatterns || []),
                resolved.sessionScope,
              ].slice(-100),
            }
          : {}),
      },
      userId,
    );
  }
  return Response.json({
    ok: true,
    approvalId,
    jobId: resolved.jobId || undefined,
    chatId: resolved.chatId,
    decision: resolved.decision,
  });
}
