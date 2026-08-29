import { randomUUID } from "node:crypto";
import { getDatabase, transaction } from "@/lib/sqlite";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/secrets";
import { getProviderDefinition } from "@/lib/providers/registry";
import { isVoiceOnlyProviderConnection } from "@/lib/providers/voice-connection";
import type {
  ProviderAuthType,
  ProviderConnection,
  ProviderModel,
  ProviderModelDefinition,
} from "@/lib/providers/types";

export { isVoiceOnlyProviderConnection } from "@/lib/providers/voice-connection";

type ConnectionRow = {
  id: string;
  owner_id: string;
  provider_key: string;
  slug: string;
  label: string;
  auth_type: ProviderAuthType;
  base_url?: string | null;
  config: string;
  secret_blob?: string | null;
  enabled: number;
  last_checked_at?: string | null;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
};

export type ProviderConnectionInput = {
  id?: string;
  providerKey: string;
  slug: string;
  label: string;
  authType: ProviderAuthType;
  baseUrl?: string;
  config?: Record<string, unknown>;
  secret?: string;
  clearSecret?: boolean;
  enabled?: boolean;
};

export type ProviderConnectionWithSecret = ProviderConnection & {
  secret?: string;
};

export function providerAuthPriority(authType: ProviderAuthType) {
  return ({
    oauth: 0,
    account: 1,
    api_key: 2,
    local: 3,
    vertex_adc: 4,
  } as Record<ProviderAuthType, number>)[authType] ?? 99;
}

function parseConfig(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function rowToConnection(row: ConnectionRow): ProviderConnection {
  return {
    id: row.id,
    ownerId: row.owner_id,
    providerKey: row.provider_key,
    slug: row.slug,
    label: row.label,
    authType: row.auth_type,
    ...(row.base_url ? { baseUrl: row.base_url } : {}),
    config: parseConfig(row.config),
    enabled: Boolean(row.enabled),
    hasSecret: Boolean(row.secret_blob),
    secretHint: row.secret_blob ? "configured" : null,
    ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(id: string, ownerId: string) {
  return getDatabase().prepare(
    `SELECT id, owner_id, provider_key, slug, label, auth_type, base_url,
            config, secret_blob, enabled, last_checked_at, last_error,
            created_at, updated_at
     FROM provider_connections
     WHERE id = ? AND owner_id = ?`,
  ).get(id, ownerId) as ConnectionRow | undefined;
}

function validateBaseUrl(baseUrl: string | undefined) {
  if (!baseUrl) return undefined;
  const parsed = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Connection URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Connection URLs must not contain embedded credentials.");
  }
  if (["169.254.169.254", "metadata.google.internal", "metadata.google"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Cloud metadata endpoints are not allowed as provider URLs.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function sanitizeConfig(value: Record<string, unknown> | undefined) {
  if (!value) return {};
  const allowedKeys = new Set(["project", "location", "organization", "modelIds", "pendingOAuthFlow", "purpose", "binaryPath"]);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowedKeys.has(key)) continue;
    if (key === "modelIds") {
      if (Array.isArray(item)) {
        result[key] = item
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim().slice(0, 200))
          .filter(Boolean)
          .slice(0, 500);
      }
      continue;
    }
    if (key === "binaryPath") {
      if (typeof item === "string" && item.trim()) result[key] = item.trim().slice(0, 500);
      continue;
    }
    if (key === "pendingOAuthFlow") {
      if (typeof item === "boolean") result[key] = item;
      continue;
    }
    if (key === "purpose") {
      if (item === "voice" || item === "chat") result[key] = item;
      continue;
    }
    if (typeof item === "string" && item.trim()) result[key] = item.trim().slice(0, 300);
  }
  return result;
}

function validateInput(input: ProviderConnectionInput) {
  const provider = getProviderDefinition(input.providerKey);
  if (!provider) throw new Error(`Unknown provider: ${input.providerKey}`);
  if (!provider.authTypes.includes(input.authType)) {
    throw new Error(`${provider.name} does not support ${input.authType} authentication.`);
  }
  const slug = input.slug.trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(slug)) {
    throw new Error("Connection ID must use 2-64 lowercase characters, numbers, dots, underscores, or hyphens.");
  }
  const label = input.label.trim().slice(0, 120);
  if (!label) throw new Error("Connection name is required.");
  return {
    provider,
    slug,
    label,
    baseUrl: validateBaseUrl(input.baseUrl?.trim() || provider.defaultBaseUrl),
    config: sanitizeConfig(input.config),
  };
}

export function listProviderConnections(ownerId: string, includeDisabled = true) {
  const rows = getDatabase().prepare(
    `SELECT id, owner_id, provider_key, slug, label, auth_type, base_url,
            config, secret_blob, enabled, last_checked_at, last_error,
            created_at, updated_at
     FROM provider_connections
     WHERE owner_id = ?
       AND COALESCE(json_extract(config, '$.pendingOAuthFlow'), 0) != 1
       ${includeDisabled ? "" : "AND enabled = 1"}
     ORDER BY provider_key ASC,
              CASE auth_type
                WHEN 'oauth' THEN 0
                WHEN 'account' THEN 1
                WHEN 'api_key' THEN 2
                WHEN 'local' THEN 3
                WHEN 'vertex_adc' THEN 4
                ELSE 99
              END ASC,
              label COLLATE NOCASE ASC`,
  ).all(ownerId) as ConnectionRow[];
  return rows.map(rowToConnection);
}

export function listChatProviderConnections(ownerId: string, includeDisabled = true) {
  return listProviderConnections(ownerId, includeDisabled).filter(
    (connection) => !isVoiceOnlyProviderConnection(connection),
  );
}

export function getProviderConnection(id: string, ownerId: string) {
  const row = getRow(id, ownerId);
  return row ? rowToConnection(row) : null;
}

export function getProviderConnectionSecret(id: string, ownerId: string) {
  const row = getRow(id, ownerId);
  if (!row) return null;
  return {
    ...rowToConnection(row),
    secret: row.secret_blob ? decryptSecret(row.secret_blob) : undefined,
  } satisfies ProviderConnectionWithSecret;
}

export function findActiveConnection(ownerId: string, providerKey: string) {
  const row = getDatabase().prepare(
    `SELECT id, owner_id, provider_key, slug, label, auth_type, base_url,
            config, secret_blob, enabled, last_checked_at, last_error,
            created_at, updated_at
     FROM provider_connections
     WHERE owner_id = ? AND provider_key = ? AND enabled = 1
     ORDER BY CASE
                WHEN auth_type = 'oauth' AND secret_blob IS NOT NULL THEN 0
                WHEN auth_type = 'account' AND secret_blob IS NOT NULL THEN 1
                WHEN auth_type = 'api_key' AND secret_blob IS NOT NULL THEN 2
                WHEN auth_type = 'local' THEN 3
                WHEN auth_type = 'vertex_adc' THEN 4
                WHEN auth_type = 'oauth' THEN 5
                WHEN auth_type = 'account' THEN 6
                WHEN auth_type = 'api_key' THEN 7
                ELSE 99
              END ASC,
              updated_at DESC
     LIMIT 1`,
  ).get(ownerId, providerKey) as ConnectionRow | undefined;
  return row ? rowToConnection(row) : null;
}

export function upsertProviderConnection(ownerId: string, input: ProviderConnectionInput) {
  const validated = validateInput(input);
  return transaction(() => {
    const db = getDatabase();
    const existing = input.id ? getRow(input.id, ownerId) : db.prepare(
      "SELECT id, owner_id, provider_key, slug, label, auth_type, base_url, config, secret_blob, enabled, last_checked_at, last_error, created_at, updated_at FROM provider_connections WHERE owner_id = ? AND slug = ?",
    ).get(ownerId, validated.slug) as ConnectionRow | undefined;
    const now = new Date().toISOString();
    const id = existing?.id || input.id || randomUUID();
    const secretBlob =
      input.clearSecret
        ? null
        : input.secret !== undefined
          ? (input.secret.trim() ? encryptSecret(input.secret.trim()) : null)
          : (existing?.secret_blob ?? null);
    db.prepare(
      `INSERT INTO provider_connections
        (id, owner_id, provider_key, slug, label, auth_type, base_url, config,
         secret_blob, enabled, last_checked_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider_key = excluded.provider_key,
         slug = excluded.slug,
         label = excluded.label,
         auth_type = excluded.auth_type,
         base_url = excluded.base_url,
         config = excluded.config,
         secret_blob = excluded.secret_blob,
         enabled = excluded.enabled,
         last_checked_at = NULL,
         last_error = NULL,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      ownerId,
      input.providerKey,
      validated.slug,
      validated.label,
      input.authType,
      validated.baseUrl ?? null,
      JSON.stringify(validated.config),
      secretBlob,
      input.enabled === false ? 0 : 1,
      existing?.created_at || now,
      now,
    );
    return getProviderConnection(id, ownerId);
  });
}

export function updateProviderConnection(
  id: string,
  ownerId: string,
  patch: Partial<Pick<ProviderConnectionInput, "label" | "baseUrl" | "enabled" | "config">> & {
    clearSecret?: boolean;
    secret?: string;
  },
) {
  const existing = getRow(id, ownerId);
  if (!existing) return null;
  const secretBlob =
    patch.clearSecret
      ? null
      : patch.secret !== undefined
        ? (patch.secret.trim() ? encryptSecret(patch.secret.trim()) : null)
        : existing.secret_blob ?? null;
  const baseUrl = patch.baseUrl === undefined
    ? existing.base_url || undefined
    : validateBaseUrl(patch.baseUrl.trim() || undefined);
  const label = patch.label === undefined ? existing.label : patch.label.trim().slice(0, 120);
  if (!label) throw new Error("Connection name is required.");
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE provider_connections
     SET label = ?, base_url = ?, config = ?, secret_blob = ?, enabled = ?,
         last_checked_at = NULL, last_error = NULL, updated_at = ?
     WHERE id = ? AND owner_id = ?`,
  ).run(
    label,
    baseUrl ?? null,
    JSON.stringify(
      patch.config === undefined
        ? parseConfig(existing.config)
        : sanitizeConfig(patch.config),
    ),
    secretBlob,
    patch.enabled === undefined ? existing.enabled : patch.enabled ? 1 : 0,
    now,
    id,
    ownerId,
  );
  return getProviderConnection(id, ownerId);
}

export function deleteProviderConnection(id: string, ownerId: string) {
  return getDatabase().prepare(
    "DELETE FROM provider_connections WHERE id = ? AND owner_id = ?",
  ).run(id, ownerId).changes > 0;
}

export function markProviderConnection(
  id: string,
  ownerId: string,
  result: { ok: boolean; error?: string },
) {
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE provider_connections
     SET last_checked_at = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND owner_id = ?`,
  ).run(now, result.ok ? null : (result.error || "Connection test failed").slice(0, 500), now, id, ownerId);
  return getProviderConnection(id, ownerId);
}

export function saveProviderModels(
  connectionId: string,
  models: Array<Pick<ProviderModel, "id" | "displayName" | "description" | "capabilities" | "contextWindow"> & {
    parameters?: ProviderModelDefinition["parameters"];
    defaultParams?: ProviderModelDefinition["defaultParams"];
    tags?: string[];
    contextWindowSource?: ProviderModelDefinition["contextWindowSource"];
    maxOutputTokens?: number;
  }>,
) {
  const db = getDatabase();
  transaction(() => {
    db.prepare("DELETE FROM provider_models WHERE connection_id = ?").run(connectionId);
    const insert = db.prepare(
      `INSERT INTO provider_models
        (connection_id, canonical_id, display_name, description, capabilities, context_window, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const discoveredAt = new Date().toISOString();
    for (const model of models.slice(0, 500)) {
      const capabilities = {
        ...(model.capabilities ?? {}),
        ...(model.parameters ? { __parameters: model.parameters } : {}),
        ...(model.defaultParams ? { __defaultParams: model.defaultParams } : {}),
        ...(model.tags ? { __tags: model.tags } : {}),
        ...(model.contextWindowSource ? { __contextWindowSource: model.contextWindowSource } : {}),
        ...(typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0
          ? { __maxOutputTokens: Math.round(model.maxOutputTokens) }
          : {}),
      };
      insert.run(
        connectionId,
        model.id,
        model.displayName.slice(0, 200),
        model.description?.slice(0, 500) ?? null,
        JSON.stringify(capabilities),
        typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0
          ? Math.round(model.contextWindow)
          : null,
        discoveredAt,
      );
    }
  });
}

function providerContextWindowSource(value: unknown): ProviderModelDefinition["contextWindowSource"] | undefined {
  return value === "provider" || value === "runtime" || value === "stored-provider" || value === "registry" || value === "catalog" || value === "inferred"
    ? value
    : undefined;
}

export function listProviderModels(connectionId: string) {
  return getDatabase().prepare(
    `SELECT canonical_id as id, display_name as displayName,
            description, capabilities, context_window as contextWindow,
            discovered_at as discoveredAt
     FROM provider_models
     WHERE connection_id = ?
     ORDER BY display_name COLLATE NOCASE ASC`,
  ).all(connectionId).map((row) => {
    const value = row as {
      id: string;
      displayName: string;
      description?: string | null;
      capabilities: string;
      contextWindow?: number | null;
      discoveredAt: string;
    };
    let capabilities: Record<string, unknown> = {};
    try {
      capabilities = JSON.parse(value.capabilities) as Record<string, unknown>;
    } catch {
      capabilities = {};
    }
    return {
      id: value.id,
      displayName: value.displayName,
      ...(value.description ? { description: value.description } : {}),
      ...(typeof value.contextWindow === "number" && value.contextWindow > 0
        ? { contextWindow: value.contextWindow }
        // Legacy rows stored the context window inside the capabilities JSON
        // before the dedicated column existed.
        : typeof capabilities.contextWindow === "number" && capabilities.contextWindow > 0
          ? { contextWindow: capabilities.contextWindow }
          : {}),
      capabilities: Object.fromEntries(
        Object.entries(capabilities).filter(([key]) => !key.startsWith("__")),
      ),
      ...(Array.isArray(capabilities.__parameters) ? { parameters: capabilities.__parameters } : {}),
      ...(Array.isArray(capabilities.__defaultParams) ? { defaultParams: capabilities.__defaultParams } : {}),
      ...(Array.isArray(capabilities.__tags) ? { tags: capabilities.__tags } : {}),
      ...(providerContextWindowSource(capabilities.__contextWindowSource)
        ? { contextWindowSource: providerContextWindowSource(capabilities.__contextWindowSource) }
        : {}),
      ...(typeof capabilities.__maxOutputTokens === "number" && capabilities.__maxOutputTokens > 0
        ? { maxOutputTokens: Math.round(capabilities.__maxOutputTokens) }
        : {}),
      discoveredAt: value.discoveredAt,
    };
  });
}

export function secretPreview(id: string, ownerId: string) {
  const row = getRow(id, ownerId);
  if (!row?.secret_blob) return null;
  try {
    return maskSecret(decryptSecret(row.secret_blob));
  } catch {
    return "configured";
  }
}
