import { readFileSync, statSync } from "node:fs";
import { internalRunLeaseAuthorized } from "@/lib/internal-run-lease";
import path from "node:path";
import { getChat } from "@/lib/db-store";
import { getUserAgentCwd } from "@/lib/mcp";
import { resolveAgentPath } from "@/lib/revert";
import { saveAttachments } from "@/lib/uploads";
import { bearerTokenMatches } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request) {
  return bearerTokenMatches(req, process.env.MCP_BEARER_TOKEN);
}

function mimeFromName(name: string) {
  const extension = path.extname(name).toLowerCase();
  return ({
    ".css": "text/css",
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".gif": "image/gif",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".py": "text/x-python",
    ".svg": "image/svg+xml",
    ".txt": "text/plain",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xml": "application/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
  } as Record<string, string>)[extension] || "application/octet-stream";
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const chatId = req.headers.get("x-ai-chat-id")?.trim() || "";
  const userId = req.headers.get("x-ai-chat-user-id")?.trim() || undefined;
  const jobId = req.headers.get("x-ai-chat-job-id")?.trim() || "";
  if (!chatId || !jobId) return Response.json({ error: "Invalid chat context" }, { status: 400 });
  if (!internalRunLeaseAuthorized(req, jobId)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const chat = getChat(chatId, userId);
  if (!chat) return Response.json({ error: "Chat not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const requestedPath = typeof body.path === "string" ? body.path.trim() : "";
  if (!requestedPath) return Response.json({ error: "path is required" }, { status: 400 });

  try {
    const agentCwd = getUserAgentCwd(userId);
    const filePath = resolveAgentPath(requestedPath, agentCwd);
    if (!filePath) return Response.json({ error: "File must be inside the agent workspace." }, { status: 400 });
    const root = path.resolve(agentCwd);
    const resolved = path.resolve(filePath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return Response.json({ error: "File must be inside the agent workspace." }, { status: 400 });
    }
    const stat = statSync(resolved);
    if (!stat.isFile()) return Response.json({ error: "The selected path is not a file." }, { status: 400 });

    const name = typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : path.basename(resolved);
    const saved = saveAttachments(chatId, [{
      name,
      mimeType: typeof body.mimeType === "string" && body.mimeType.trim()
        ? body.mimeType
        : mimeFromName(name),
      data: readFileSync(resolved).toString("base64"),
    }], userId);
    const attachment = saved.stored[0];
    if (!attachment) throw new Error("Could not store the file.");
    const url = `/api/uploads/${encodeURIComponent(chatId)}/${encodeURIComponent(attachment.storedName)}`;
    return Response.json({
      attachment,
      downloadUrl: url,
      markdown: attachment.mimeType.startsWith("image/")
        ? `![${attachment.name}](${url})`
        : `[Download ${attachment.name}](${url})`,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not provide file." },
      { status: 400 },
    );
  }
}
