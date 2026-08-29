import { Cursor } from "@cursor/sdk";
import { getAuthenticatedUserId, isAuthenticated } from "@/lib/auth";
import { filterAllowedModels } from "@/lib/model-access";
import {
  defaultParamsForModel,
  modelParametersForModel,
} from "@/lib/model-params";
import {
  findActiveConnection,
  getProviderConnectionSecret,
  listChatProviderConnections,
  listProviderModels,
  providerAuthPriority,
} from "@/lib/provider-connections";
import {
  persistDiscoveredModels,
  providerModelCacheState,
  providerModelsForConnection,
  scheduleProviderModelRefresh,
} from "@/lib/providers/discovery";
import { modelKey } from "@/lib/providers/types";
import { contextWindowOf as providerContextWindow } from "@/lib/context-window";
import { resolveModelContextMetadata } from "@/lib/model-context-metadata";
import { getVerifiedProviderCapabilities } from "@/lib/providers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ModelParamValue = {
  value: string;
  displayName?: string;
};

export type ModelParameter = {
  id: string;
  displayName?: string;
  values: ModelParamValue[];
};

export type ModelParamSelection = {
  id: string;
  value: string;
};

export type ModelInfo = {
  id: string;
  displayName: string;
  description?: string;
  providerId?: string;
  providerName?: string;
  connectionId?: string;
  connectionLabel?: string;
  source?: "cursor" | "catalog" | "discovered";
  tags?: string[];
  capabilities?: Record<string, boolean>;
  parameters?: ModelParameter[];
  defaultParams?: ModelParamSelection[];
  contextWindow?: number;
  contextWindowSource?: "provider" | "runtime" | "stored-provider" | "registry" | "catalog" | "inferred";
  maxOutputTokens?: number;
};


function modelContextWindow(value: unknown, id?: string, displayName?: string) {
 const record = value && typeof value === "object"
 ? value as { id?: unknown; displayName?: unknown; contextWindow?: unknown }
 : null;
 return providerContextWindow({
 id: id || (typeof record?.id === "string" ? record.id : ""),
 displayName: displayName || (typeof record?.displayName === "string" ? record.displayName : ""),
 contextWindow: record?.contextWindow,
 }) ?? providerContextWindow(value);
}

export async function GET(req: Request) {
  if (!(await isAuthenticated(req))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = await getAuthenticatedUserId(req);

  const cursorConnection = userId ? findActiveConnection(userId, "cursor") : null;
  let cursorCredential: string | undefined;
  try {
    cursorCredential = cursorConnection && userId
      ? getProviderConnectionSecret(cursorConnection.id, userId)?.secret
      : undefined;
  } catch {
    cursorCredential = undefined;
  }
  const apiKey = cursorCredential;
  let cursorModels: ModelInfo[] = [];
  let cursorSource: "cursor" | "none" = "none";
  let error: string | undefined;

  if (apiKey) {
    try {
      const listed = await Cursor.models.list({ apiKey });
      const storedById = cursorConnection
        ? new Map(listProviderModels(cursorConnection.id).map((model) => [model.id, model]))
        : new Map<string, { contextWindow?: number; contextWindowSource?: ModelInfo["contextWindowSource"] }>();
      cursorModels = listed.map((m) => {
        const defaultVariant =
          m.variants?.find((v) => v.isDefault) ?? m.variants?.[0];
        const cursorParams = (m.parameters ?? []).map((p) => ({
          id: p.id,
          displayName: p.displayName,
          values: p.values.map((v) => ({
            value: v.value,
            displayName: v.displayName,
          })),
        }));
        const variantParams = (defaultVariant?.params ?? [])
          .filter((p) => p.id !== "cyber")
          .map((p) => ({ id: p.id, value: p.value }));
        const discoveredWindow = providerContextWindow(m);
        const storedModel = storedById.get(m.id);
        const metadata = cursorConnection
          ? resolveModelContextMetadata({
              connection: cursorConnection,
              modelId: m.id,
              displayName: m.displayName || m.id,
              providerContextWindow: discoveredWindow,
              storedContextWindow: storedModel?.contextWindow,
              storedContextWindowSource: storedModel?.contextWindowSource,
            })
          : { contextWindow: discoveredWindow, source: discoveredWindow ? "provider" as const : undefined };
        const contextWindow = metadata.contextWindow;
 const normalizedModel = {
          id: m.id,
          displayName: m.displayName || m.id,
          contextWindow,
          parameters: cursorParams,
          defaultParams: variantParams,
 variants: (m.variants ?? []).map((variant) => variant.params.map((param) => ({ id: param.id, value: param.value }))),
        };
        const parameters = modelParametersForModel(normalizedModel);
        const defaultParams = defaultParamsForModel({
          ...normalizedModel,
          parameters,
        });
        return {
          id: m.id,
          displayName: m.displayName || m.id,
          ...(contextWindow ? { contextWindow } : {}),
          ...(metadata.source ? { contextWindowSource: metadata.source } : {}),
          ...(metadata.maxOutputTokens ? { maxOutputTokens: metadata.maxOutputTokens } : {}),
          providerId: "cursor",
          providerName: "Cursor",
          source: "cursor",
          description: m.description,
          capabilities: getVerifiedProviderCapabilities("cursor", m.id)?.verified,
          parameters,
          defaultParams,
        };
      });
      cursorSource = "cursor";
      if (cursorConnection) {
        persistDiscoveredModels(
          cursorConnection.id,
          listed.map((m) => {
            const discoveredWindow = providerContextWindow(m);
            const defaultVariant = m.variants?.find((variant) => variant.isDefault) ?? m.variants?.[0];
            const variantParams = (defaultVariant?.params ?? []).map((param) => ({ id: param.id, value: param.value }));
            const stored = storedById.get(m.id);
            const metadata = resolveModelContextMetadata({
              connection: cursorConnection,
              modelId: m.id,
              displayName: m.displayName || m.id,
              providerContextWindow: discoveredWindow,
              storedContextWindow: stored?.contextWindow,
              storedContextWindowSource: stored?.contextWindowSource,
            });
 return {
              id: m.id,
              displayName: m.displayName || m.id,
              description: m.description,
              ...(metadata.contextWindow ? { contextWindow: metadata.contextWindow, contextWindowDiscovered: Boolean(discoveredWindow), contextWindowSource: metadata.source } : {}),
              ...(metadata.maxOutputTokens ? { maxOutputTokens: metadata.maxOutputTokens } : {}),
              parameters: (m.parameters ?? []).map((p) => ({
                id: p.id,
                displayName: p.displayName,
                values: p.values.map((v) => ({ value: v.value, displayName: v.displayName })),
              })),
              defaultParams: variantParams,
            };
          }),
        );
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Failed to list Cursor models";
    }
  }

  const connections = userId
    ? listChatProviderConnections(userId, false)
        .filter((connection) => {
          if (connection.authType === "local" || connection.authType === "vertex_adc") return true;
          return Boolean(getProviderConnectionSecret(connection.id, userId)?.secret);
        })
        .sort((a, b) => providerAuthPriority(a.authType) - providerAuthPriority(b.authType))
    : [];
  if (userId) {
    const emptyRefreshes: Array<Promise<unknown>> = [];
    for (const connection of connections) {
      if (connection.providerKey === "cursor" || !connection.enabled) continue;
      const state = providerModelCacheState(connection.id);
      if (state === "fresh") continue;
      const secretConnection = getProviderConnectionSecret(connection.id, userId);
      if (!secretConnection) continue;
      if (state === "empty") emptyRefreshes.push(scheduleProviderModelRefresh(secretConnection));
      else void scheduleProviderModelRefresh(secretConnection);
    }
    if (emptyRefreshes.length) await Promise.all(emptyRefreshes);
  }
  const connectionModels: ModelInfo[] = [];
  for (const connection of connections) {
    if (connection.providerKey === "cursor") continue;
    const models = providerModelsForConnection({ ...connection });
    connectionModels.push(
      ...models.map((model) => {
        const contextWindow = modelContextWindow(model, model.id, model.displayName);
        const baseParameters = model.parameters?.map((parameter) => ({
          id: parameter.id,
          displayName: parameter.displayName,
          values: parameter.values.map((value) => ({ ...value })),
        })) || [];
        const normalizedModel = {
          id: model.id,
          displayName: model.displayName,
          providerId: model.providerKey,
          contextWindow,
          capabilities: model.capabilities as Record<string, boolean> | undefined,
          parameters: baseParameters,
          defaultParams: model.defaultParams?.map((parameter) => ({ ...parameter })),
        };
        const parameters = modelParametersForModel(normalizedModel);
        const defaultParams = defaultParamsForModel({
          ...normalizedModel,
          parameters,
        });
        return {
          id: model.key || modelKey(model.providerKey, model.id),
          displayName: model.displayName,
          description: model.description,
          providerId: model.providerKey,
          providerName: model.providerName,
          connectionId: model.connectionId,
          connectionLabel: model.connectionLabel,
          source: model.source,
          tags: "tags" in model && Array.isArray(model.tags) ? model.tags : undefined,
          ...(contextWindow ? { contextWindow } : {}),
          ...(model.contextWindowSource ? { contextWindowSource: model.contextWindowSource } : {}),
          ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
          capabilities: model.capabilities as Record<string, boolean> | undefined,
          ...(parameters.length ? { parameters } : {}),
          defaultParams,
        };
      }),
    );
  }

  const allModels = [...cursorModels, ...connectionModels];
  const allowedModels = filterAllowedModels(userId ?? undefined, allModels);
  return Response.json({
    models: allowedModels,
    defaultModelId: allowedModels[0]?.id || "",
    source: cursorSource,
    providers: connections.map((connection) => ({
      id: connection.id,
      providerKey: connection.providerKey,
      label: connection.label,
      enabled: connection.enabled,
    })),
    ...(error ? { error } : {}),
  });
}
