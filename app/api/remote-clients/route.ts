import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import {
  createEnrollmentToken,
  listRemoteAudit,
  listRemoteClients,
} from "@/lib/remote-clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicOrigin(req: Request) {
  const configured = process.env.AI_CHAT_PUBLIC_URL?.trim();
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedCandidate = forwardedHost ? (
    `${forwardedProto === "https" ? "https" : "http"}://${forwardedHost}`
  ) : "";
  let candidate = configured || forwardedCandidate || new URL(req.url).origin;
  try {
    const configuredUrl = configured ? new URL(configured) : null;
    if (configuredUrl && ["localhost", "127.0.0.1", "::1"].includes(configuredUrl.hostname) && forwardedCandidate) {
      candidate = forwardedCandidate;
    }
  } catch {
    // The validation below returns the user-facing configuration error.
  }
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("AI_CHAT_PUBLIC_URL must use http or https");
  if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("Configure AI_CHAT_PUBLIC_URL with the server domain before creating a remote client");
  }
  return parsed.origin;
}

export async function GET(req: Request) {
  if (!(await isAuthenticated(req))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const ownerId = await getAuthenticatedUserId(req);
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  return Response.json({
    clients: listRemoteClients(ownerId),
    audit: url.searchParams.get("audit") === "1" ? listRemoteAudit(ownerId) : undefined,
  });
}

export async function POST(req: Request) {
  if (!(await isAuthenticated(req))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const ownerId = await getAuthenticatedUserId(req);
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const requestBody = (await req.json().catch(() => ({}))) as { os?: unknown; permissionMode?: unknown };
  const selectedOs = requestBody.os === "windows" || requestBody.os === "macos" ? requestBody.os : "linux";
  const permissionMode = requestBody.permissionMode === "admin" ? "admin" : "user";
  const token = createEnrollmentToken(ownerId);
  let publicUrl: string;
  try {
    publicUrl = publicOrigin(req);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Public server URL is not configured" }, { status: 400 });
  }
  const command = `curl -fsSL ${publicUrl}/install/remote-client.sh | bash -s -- --server ${publicUrl} --enrollment-token ${token.token} --permission-mode ${permissionMode}`;
  const windowsCommand = `& ([scriptblock]::Create((irm ${publicUrl}/install/remote-client.ps1))) -Server '${publicUrl}' -EnrollmentToken '${token.token}' -PermissionMode '${permissionMode}'`;
  const macosCommand = `curl -fsSL ${publicUrl}/install/remote-client-macos.sh | bash -s -- --server ${publicUrl} --enrollment-token ${token.token} --permission-mode ${permissionMode}`;
  const selectedCommand = selectedOs === "windows" ? windowsCommand : selectedOs === "macos" ? macosCommand : command;
  return Response.json({
    ...token,
    command: selectedCommand,
    commands: { linux: command, windows: windowsCommand, macos: macosCommand },
    permissionMode,
  }, { status: 201 });
}

