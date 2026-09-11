import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import { checkGatewayHealth } from "@/lib/mcp";
import { listChatProviderConnections } from "@/lib/provider-connections";
import { getUserAgentCwd } from "@/lib/mcp";
import { getSetupStatus } from "@/lib/setup";
import { readWorkerHeartbeat } from "@/lib/worker-health";
import { isHostAdmin } from "@/lib/user-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const authed = await isAuthenticated(req);
  const gateway = await checkGatewayHealth();
  const worker = readWorkerHeartbeat();
  const ownerId = await getAuthenticatedUserId(req);
  const connections = ownerId ? listChatProviderConnections(ownerId) : [];
  const hasCursorSdkConnection = connections.some(
    (connection) => connection.providerKey === "cursor" && connection.enabled && connection.hasSecret,
  );

  return Response.json({
    authenticated: authed,
    agentCwd: ownerId ? getUserAgentCwd(ownerId) : undefined,
    cursorSdkConfigured: hasCursorSdkConnection,
    isHostAdmin: Boolean(ownerId && isHostAdmin(ownerId)),
    setup: getSetupStatus(ownerId ?? undefined),
    providers: connections.map((connection) => ({
      id: connection.id,
      providerKey: connection.providerKey,
      label: connection.label,
      enabled: connection.enabled,
      hasSecret: connection.hasSecret,
      lastError: connection.lastError,
    })),
    mcp: gateway,
    worker,
  }, { status: worker.ok ? 200 : 503 });
}
