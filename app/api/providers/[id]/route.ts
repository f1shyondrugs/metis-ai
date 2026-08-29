import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import {
  deleteProviderConnection,
  getProviderConnection,
  updateProviderConnection,
} from "@/lib/provider-connections";
import { getGlobalModelSettings, saveGlobalModelSettings } from "@/lib/db-store";
import { parseModelKey } from "@/lib/providers/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

async function owner(req: Request) {
  if (!(await isAuthenticated(req))) return null;
  return getAuthenticatedUserId(req);
}

function modelUsesConnection(value: unknown, connectionId: string) {
  return typeof value === "string" && parseModelKey(value).connectionId === connectionId;
}

function removeConnectionFromSettings(ownerId: string, connectionId: string) {
  const current = getGlobalModelSettings(ownerId);
  const next = { ...current };
  let changed = false;

  if (modelUsesConnection(next.modelId, connectionId)) {
    delete next.modelId;
    delete next.modelParams;
    changed = true;
  }
  if (modelUsesConnection(next.subagentModelId, connectionId)) {
    delete next.subagentModelId;
    next.subagentModelEnabled = false;
    changed = true;
  }
  if (next.favoriteModelKeys?.some((value) => modelUsesConnection(value, connectionId))) {
    next.favoriteModelKeys = next.favoriteModelKeys.filter((value) => !modelUsesConnection(value, connectionId));
    changed = true;
  }
  if (next.modelParamsByModel) {
    const entries = Object.entries(next.modelParamsByModel).filter(([key]) => !modelUsesConnection(key, connectionId));
    if (entries.length !== Object.keys(next.modelParamsByModel).length) {
      next.modelParamsByModel = Object.fromEntries(entries);
      changed = true;
    }
  }
  if (next.lastModelByProvider) {
    const entries = Object.entries(next.lastModelByProvider).filter(([, value]) => !modelUsesConnection(value, connectionId));
    if (entries.length !== Object.keys(next.lastModelByProvider).length) {
      next.lastModelByProvider = Object.fromEntries(entries);
      changed = true;
    }
  }
  if (next.modelAliases) {
    const entries = Object.entries(next.modelAliases).filter(
      ([key, value]) => !modelUsesConnection(key, connectionId) && !modelUsesConnection(value, connectionId),
    );
    if (entries.length !== Object.keys(next.modelAliases).length) {
      next.modelAliases = Object.fromEntries(entries);
      changed = true;
    }
  }
  if (next.voiceInput?.connectionId === connectionId) {
    const { connectionId: _removedConnectionId, ...voiceInput } = next.voiceInput;
    next.voiceInput = voiceInput;
    changed = true;
  }

  if (changed) saveGlobalModelSettings(next, ownerId);
}

export async function GET(req: Request, { params }: Params) {
  const ownerId = await owner(req);
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const connection = getProviderConnection(id, ownerId);
  if (!connection) return Response.json({ error: "Connection not found." }, { status: 404 });
  return Response.json({ connection });
}

export async function PATCH(req: Request, { params }: Params) {
  const ownerId = await owner(req);
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const connection = updateProviderConnection(id, ownerId, {
      ...(typeof body.label === "string" ? { label: body.label } : {}),
      ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(body.config && typeof body.config === "object" && !Array.isArray(body.config)
        ? { config: body.config as Record<string, unknown> }
        : {}),
      ...(typeof body.secret === "string" ? { secret: body.secret } : {}),
      ...(body.clearSecret === true ? { clearSecret: true } : {}),
    });
    if (!connection) return Response.json({ error: "Connection not found." }, { status: 404 });
    return Response.json({ connection });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to update provider connection." },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const ownerId = await owner(req);
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const connection = getProviderConnection(id, ownerId);
  if (!connection) return Response.json({ error: "Connection not found." }, { status: 404 });
  if (!deleteProviderConnection(id, ownerId)) {
    return Response.json({ error: "Connection not found." }, { status: 404 });
  }
  removeConnectionFromSettings(ownerId, id);
  return Response.json({ ok: true, removed: { id, providerKey: connection.providerKey } });
}
