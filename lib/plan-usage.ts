import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "@/lib/config";
import { getDatabase } from "@/lib/sqlite";
import {
  findActiveConnection,
  getProviderConnectionSecret,
  listProviderConnections,
  updateProviderConnection,
} from "@/lib/provider-connections";
import { readCodexOAuthCredentials } from "@/lib/providers/discovery";
import type { UsageProvider, UsageSnapshot, UsageWindow } from "@/lib/usage-display";
import { parseCursorUsageBody } from "@/lib/usage-display";

export type { UsageProvider, UsageSnapshot, UsageWindow };

/**
 * Central plan-usage module.
 *
 * All subscription/quota lookups for providers with usage limits live here —
 * one module, one cache, one API shape. Nothing else in Metis queries
 * usage endpoints directly.
 *
 * Sources:
 *  - Cursor: GET cursor.com/api/usage-summary (session or API key) plus local Cursor app session
 *  - Codex (ChatGPT plan): `codex app-server --stdio` JSON-RPC `account/rateLimits/read`
 *  - z.ai Coding Plan: GET https://api.z.ai/api/monitor/usage/quota/limit (raw key, no Bearer)
 *  - Antigravity: POST cloudcode-pa.googleapis.com v1internal:fetchAvailableModels (quotaInfo per model)
 *  - Local gateway 5h stats: read-only SQLite on the AiApi-Wrapper gateway.db
 */

const CACHE_TTL_MS = 60_000;
const PERSISTED_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const cache = new Map<string, UsageSnapshot>();
const inflight = new Map<string, Promise<UsageSnapshot>>();
const PERSISTED_USAGE_DIR = path.join(config.dataDir, "plan-usage-cache");

function usageCacheFile(ownerId?: string) {
  const key = createHash("sha256").update(ownerId || "global").digest("hex").slice(0, 32);
  return path.join(PERSISTED_USAGE_DIR, `${key}.json`);
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UsageSnapshot>;
  return Array.isArray(candidate.providers) && typeof candidate.fetchedAt === "string";
}

function loadPersistedUsage(ownerId?: string): UsageSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(usageCacheFile(ownerId), "utf8")) as unknown;
    if (!isUsageSnapshot(parsed)) return null;
    const age = Date.now() - Date.parse(parsed.fetchedAt);
    if (!Number.isFinite(age) || age < 0 || age > PERSISTED_CACHE_MAX_AGE_MS) return null;
    return {
      ...parsed,
      providers: parsed.providers.map((provider) => ({
        ...provider,
        status: provider.status === "live" ? "stale" as const : provider.status,
      })),
    };
  } catch {
    return null;
  }
}

function persistUsage(ownerId: string | undefined, snapshot: UsageSnapshot) {
  try {
    mkdirSync(PERSISTED_USAGE_DIR, { recursive: true });
    const target = usageCacheFile(ownerId);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(temporary, target);
  } catch {
    // Quota persistence is only a render cache. Never fail a request because of it.
  }
}

const HOME = homedir();
const CODEX_BIN = process.env.CODEX_BIN || path.join(config.root, "node_modules/.bin/codex");
const GATEWAY_DB = process.env.GATEWAY_DB_PATH || `${HOME}/AiApi-Wrapper/data/gateway.db`;
const WRAPPER_ENV = process.env.WRAPPER_ENV || path.join(homedir(), "AiApi-Wrapper/.env");

function readWrapperEnvKey(names: string[]): string | undefined {
  try {
    const raw = readFileSync(WRAPPER_ENV, "utf8");
    for (const name of names) {
      const m = raw.match(new RegExp(`^${name}=["']?([^"'\\n]+)["']?`, "m"));
      if (m?.[1]) return m[1];
    }
  } catch {
    /* fall through to process.env */
  }
  for (const name of names) {
    const v = process.env[name];
    if (v) return v;
  }
  return undefined;
}

function epochMsToIso(value: unknown): string | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000; // seconds vs milliseconds
  return new Date(ms).toISOString();
}

/* ---------------- Codex (ChatGPT plan) ---------------- */

type CodexWindow = Record<string, unknown> | null;

export function codexWindowLabel(mins: number): string {
  if (mins >= 10080) return "weekly";
  if (mins >= 4 * 60 && mins <= 6 * 60) return "5h";
  if (mins >= 2880) return `${Math.round(mins / 1440)}d`;
  if (mins > 60) return `${Math.round(mins / 60)}h`;
  return `${mins}m`;
}

export function normalizeCodexWindow(w: CodexWindow): UsageWindow | null {
  if (!w) return null;
  const usedValue = w.usedPercent ?? w.used_percent ?? w.percentage;
  const usedPercent = typeof usedValue === "number" ? usedValue : Number(usedValue);
  if (!Number.isFinite(usedPercent)) return null;
  const durationValue =
    w.windowDurationMins ??
    w.window_duration_mins ??
    w.limitWindowMins ??
    (w.windowDurationSeconds !== undefined ? Number(w.windowDurationSeconds) / 60 : undefined) ??
    (w.limitWindowSeconds !== undefined ? Number(w.limitWindowSeconds) / 60 : undefined);
  const duration = typeof durationValue === "number" ? durationValue : Number(durationValue);
  const resetValue = w.resetsAt ?? w.resetAt ?? w.reset_at ?? w.resetTime;
  return {
    label: Number.isFinite(duration) && duration > 0 ? codexWindowLabel(duration) : "quota",
    usedPercent: Math.round(Math.min(100, Math.max(0, usedPercent))),
    resetsAt: epochMsToIso(resetValue),
  };
}

type CodexUsageHome = {
  home: string;
  authTokens?: { accessToken: string; chatgptAccountId: string; chatgptPlanType?: string | null };
  apiKey?: string;
  cleanup: () => void;
};

export function readCodexUsageOAuthCredentials(secret: string) {
  // The Codex app server can exchange the refresh token even when the cached
  // access token has expired. Rejecting the credential here prevents that
  // refresh and incorrectly reports a configured account as disconnected.
  return readCodexOAuthCredentials(secret, { allowExpired: true });
}

function createCodexUsageHome(ownerId?: string): CodexUsageHome | null {
  if (!ownerId) return null;
  try {
    const connection = findActiveConnection(ownerId, "codex");
    if (!connection || !connection.enabled) return null;
    const credential = getProviderConnectionSecret(connection.id, ownerId);
    if (!credential?.secret?.trim()) return null;

    let auth: Record<string, unknown> = {};
    let authTokens: CodexUsageHome["authTokens"];
    if (connection.authType === "oauth") {
      const oauth = readCodexUsageOAuthCredentials(credential.secret);
      authTokens = {
        accessToken: oauth.access,
        chatgptAccountId: oauth.accountId,
      };
      auth = {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          access_token: oauth.access,
          refresh_token: oauth.refresh,
          id_token: oauth.idToken,
          account_id: oauth.accountId,
        },
        last_refresh: new Date(oauth.expires).toISOString(),
      };
    } else if (connection.authType === "account") {
      const parsed = JSON.parse(credential.secret) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      auth = parsed as Record<string, unknown>;
    } else if (connection.authType !== "api_key") {
      return null;
    }

    const home = mkdtempSync(path.join(tmpdir(), "metis-codex-usage-"));
    writeFileSync(path.join(home, "auth.json"), `${JSON.stringify(auth)}\n`, { mode: 0o600 });
    return {
      home,
      ...(authTokens ? { authTokens } : {}),
      ...(connection.authType === "api_key" ? { apiKey: credential.secret.trim() } : {}),
      cleanup: () => {
        try { rmSync(home, { recursive: true, force: true }); } catch { /* already gone */ }
      },
    };
  } catch {
    return null;
  }
}

async function fetchCodexUsage(ownerId?: string): Promise<UsageProvider> {
  const connection = ownerId ? findActiveConnection(ownerId, "codex") : null;
  const base: UsageProvider = {
    key: "codex",
    name: "Codex (ChatGPT plan)",
    status: "live",
    windows: [],
    source: "dashboard",
    ...(connection?.id ? { connectionId: connection.id } : {}),
  };
  const usageHome = createCodexUsageHome(ownerId);
  if (!usageHome) return { ...base, status: "no_auth", error: "no authenticated Codex account connection" };

  return new Promise<UsageProvider>((resolve) => {
    let settled = false;
    let child: ReturnType<typeof execFile> | null = null;
    const done = (provider: UsageProvider) => {
      if (settled) return;
      settled = true;
      try { child?.kill("SIGTERM"); } catch { /* noop */ }
      usageHome.cleanup();
      resolve(provider);
    };
    const timer = setTimeout(() => done({ ...base, status: "error", error: "timeout" }), 8_000);
    try {
      child = execFile(
        CODEX_BIN,
        ["app-server", "--stdio"],
        {
          env: {
            ...process.env,
            ...(usageHome.apiKey ? { CODEX_API_KEY: usageHome.apiKey } : {}),
            CODEX_HOME: usageHome.home,
          },
          timeout: 7_500,
        },
        () => {
          /* handled via stdout below */
        },
      );
      if (!child.stdout || !child.stdin) {
        clearTimeout(timer);
        return done({ ...base, status: "error", error: "spawn failed" });
      }
      let buffer = "";
      const send = (obj: unknown) => {
        try { child?.stdin?.write(`${JSON.stringify(obj)}\n`); } catch { /* closed */ }
      };
      child.stdin.on("error", () => {});
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id === 2 && usageHome.authTokens) {
            const loginError = msg.error && typeof msg.error === "object"
              ? msg.error as Record<string, unknown>
              : null;
            if (loginError) {
              clearTimeout(timer);
              const message = typeof loginError.message === "string" ? loginError.message : "Codex login failed";
              return done({ ...base, status: "no_auth", error: message });
            }
            send({ jsonrpc: "2.0", id: 3, method: "account/rateLimits/read", params: {} });
            continue;
          }
          const rateLimitId = usageHome.authTokens ? 3 : 2;
          if (msg.id !== rateLimitId) continue;
          clearTimeout(timer);
          const rpcError = msg.error && typeof msg.error === "object"
            ? msg.error as Record<string, unknown>
            : null;
          if (rpcError) {
            const message = typeof rpcError.message === "string" ? rpcError.message : "rate-limit request failed";
            const code = typeof rpcError.code === "number" || typeof rpcError.code === "string"
              ? ` (${rpcError.code})`
              : "";
            const status = /auth|login|credential|unauthorized|required|401|403/i.test(message)
              ? "no_auth"
              : "error";
            return done({ ...base, status, error: `${message}${code}` });
          }
          const result = (msg.result as { rateLimits?: Record<string, unknown> } | undefined)?.rateLimits;
          if (!result) return done({ ...base, status: "error", error: "unsupported: no rate limits in response" });
          const planType = typeof result.planType === "string" ? result.planType : undefined;
          const windows = [
            normalizeCodexWindow(result.primary as CodexWindow),
            normalizeCodexWindow(result.secondary as CodexWindow),
            normalizeCodexWindow(result.weekly as CodexWindow),
            normalizeCodexWindow(result.fiveHour as CodexWindow),
          ].filter((window): window is UsageWindow => window !== null);
          return done({
            ...base,
            planLabel: planType ? planType.charAt(0).toUpperCase() + planType.slice(1) : undefined,
            windows,
            extra: {
              spendControlReached: result.spendControlReached === true ? "yes" : "no",
              rateLimitReachedType: typeof result.rateLimitReachedType === "string"
                ? result.rateLimitReachedType
                : null,
              credits: typeof result.credits === "number" ? result.credits : null,
              resetsAt: typeof result.resetAt === "string" ? result.resetAt : null,
            },
          });
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        done({ ...base, status: "error", error: error.message || "spawn error" });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        done({
          ...base,
          status: "error",
          error: signal ? `app-server ${signal}` : `app-server exited (${code ?? "unknown"})`,
        });
      });
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "metis-usage", version: "1.0" }, capabilities: { experimentalApi: true } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      if (usageHome.authTokens) {
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "account/login/start",
          params: { type: "chatgptAuthTokens", ...usageHome.authTokens },
        });
      } else {
        send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
      }
    } catch (error) {
      clearTimeout(timer);
      done({ ...base, status: "error", error: error instanceof Error ? error.message : "spawn failed" });
    }
  });
}

/* ---------------- z.ai Coding Plan ---------------- */

type ZaiLimit = {
  type?: string;
  percentage?: number;
  nextResetTime?: number;
  unit?: number;
  number?: number;
};

async function fetchZaiUsage(ownerId?: string): Promise<UsageProvider> {
  const base: UsageProvider = { key: "zai", name: "z.ai Coding Plan", status: "live", windows: [] };
  const keys: Array<{ secret: string; connectionId?: string }> = [];
  if (ownerId) {
    const candidates = listProviderConnections(ownerId, false)
      .filter((connection) => /z\.?ai|z-ai|glm/i.test(`${connection.label} ${connection.baseUrl || ""}`))
      .sort((a, b) => Number(/coding/i.test(`${b.label} ${b.baseUrl || ""}`)) - Number(/coding/i.test(`${a.label} ${a.baseUrl || ""}`)));
    for (const connection of candidates) {
      try {
        const secret = getProviderConnectionSecret(connection.id, ownerId)?.secret?.trim();
        if (secret && !keys.some((item) => item.secret === secret)) keys.push({ secret, connectionId: connection.id });
      } catch {
        /* try the next z.ai-compatible connection */
      }
    }
  }
  if (!ownerId) {
    const fallbackKey = readWrapperEnvKey(["GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY"]);
    if (fallbackKey && !keys.some((item) => item.secret === fallbackKey)) keys.push({ secret: fallbackKey });
  }
  if (!keys.length) return { ...base, status: "no_auth", error: "no z.ai API key found" };

  let lastError = "quota lookup failed";
  for (const credential of keys) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
        headers: { Authorization: credential.secret, Accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const body = (await res.json()) as {
        data?: { limits?: ZaiLimit[]; level?: string };
      };
      const limits = body.data?.limits ?? [];
      const level = typeof body.data?.level === "string" ? body.data.level : undefined;
      const windows: UsageWindow[] = [];
      for (const limit of limits) {
        if (limit.type === "TOKENS_LIMIT") {
          const hours = limit.number && limit.unit === 3 ? limit.number : 5;
          windows.push({
            label: `${hours}h`,
            usedPercent: typeof limit.percentage === "number" ? Math.round(limit.percentage) : null,
            resetsAt: epochMsToIso(limit.nextResetTime),
          });
        } else if (limit.type === "TIME_LIMIT") {
          windows.push({
            label: limit.number === 1 && limit.unit === 5 ? "monthly" : "time",
            usedPercent: typeof limit.percentage === "number" ? Math.round(limit.percentage) : null,
            resetsAt: epochMsToIso(limit.nextResetTime),
          });
        }
      }
      return {
        ...base,
        ...(credential.connectionId ? { connectionId: credential.connectionId } : {}),
        source: "dashboard",
        planLabel: level ? level.charAt(0).toUpperCase() + level.slice(1) : undefined,
        windows,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "fetch failed";
    }
  }
  return { ...base, status: /401/.test(lastError) ? "no_auth" : "error", error: lastError };
}

/* ---------------- Antigravity ---------------- */

function antigravityAccessToken(secret: string | undefined): string | null {
  if (!secret?.trim()) return null;
  try {
    const raw = JSON.parse(secret) as { token?: unknown };
    const token = typeof raw.token === "string"
      ? raw.token
      : raw.token && typeof raw.token === "object"
        ? (raw.token as { access_token?: unknown }).access_token
        : undefined;
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

export function antigravityCredentialNeedsRefresh(secret: string | undefined, now = Date.now()) {
  if (!secret?.trim()) return false;
  try {
    const raw = JSON.parse(secret) as { token?: unknown };
    if (!raw.token || typeof raw.token !== "object") return false;
    const expiry = (raw.token as { expiry?: unknown }).expiry;
    if (typeof expiry !== "string") return false;
    const expiresAt = Date.parse(expiry);
    if (!Number.isFinite(expiresAt)) return false;
    // Refresh before it is actually unusable. This avoids a guaranteed 401 and
    // gives the CLI enough time to renew the OAuth token in the background.
    return expiresAt <= now + 60_000;
  } catch {
    return false;
  }
}

/** Ask the official Antigravity CLI to refresh its own token file without
 * starting a model turn. `agy models` performs authenticated model discovery,
 * which exercises the same automatic token refresh used by normal CLI runs. */
async function refreshAntigravityCredential(secret: string): Promise<string | null> {
  const command = process.env.AGY_CLI_PATH?.trim() || path.join(HOME, ".local", "bin", "agy");
  if (!existsSync(command)) return null;
  const home = mkdtempSync(path.join(tmpdir(), "metis-agy-usage-"));
  const tokenFile = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  try {
    mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile, secret, { mode: 0o600 });
    await new Promise<void>((resolve) => {
      const child = execFile(
        command,
        ["models"],
        {
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: path.join(home, ".config"),
            XDG_CACHE_HOME: path.join(home, ".cache"),
          },
          timeout: 10_000,
          maxBuffer: 512_000,
        },
        () => resolve(),
      );
      // agy keeps an async pipe open waiting for stdin even for the non-
      // interactive `models` command. Explicit EOF lets it finish its OAuth
      // refresh instead of sitting until Node's timeout kills it.
      child.stdin?.end();
    });
    const refreshed = readFileSync(tokenFile, "utf8");
    return antigravityAccessToken(refreshed) ? refreshed : null;
  } catch {
    return null;
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

async function fetchAntigravityUsage(ownerId?: string): Promise<UsageProvider> {
  const base: UsageProvider = { key: "antigravity", name: "Antigravity", status: "live", windows: [], source: "dashboard" };
  const credentials: Array<{ secret: string; connectionId?: string }> = [];
  const addCredential = (secret: string | undefined, connectionId?: string) => {
    if (!secret?.trim() || !antigravityAccessToken(secret)) return;
    if (credentials.some((item) => item.secret === secret)) return;
    credentials.push({ secret, ...(connectionId ? { connectionId } : {}) });
  };

  if (ownerId) {
    for (const connection of listProviderConnections(ownerId, false).filter((item) => item.providerKey === "antigravity")) {
      try {
        addCredential(getProviderConnectionSecret(connection.id, ownerId)?.secret, connection.id);
      } catch {
        /* try the next account-scoped connection */
      }
    }

 } else {
    try {
      addCredential(readFileSync(`${HOME}/.gemini/antigravity-cli/antigravity-oauth-token`, "utf8"));
    } catch {
      /* no unscoped CLI token */
    }
  }

  // The CLI may have refreshed its host-scoped token after the account
 // connection was stored. Use it as a fallback for the local Metis user.
 try {
 addCredential(readFileSync(`${HOME}/.gemini/antigravity-cli/antigravity-oauth-token`, "utf8"));
 } catch {
 /* no local CLI token */
 }

 if (!credentials.length) return { ...base, status: "no_auth", error: "no authenticated Antigravity connection" };

  const readQuota = async (token: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      return await fetch(
        "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "antigravity-usage/1.0",
          },
          body: "{}",
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }
  };

  let lastError = "quota lookup failed";
  for (const credential of credentials) {
    try {
      let secret = credential.secret;
      let token = antigravityAccessToken(secret)!;

      const refreshCredential = async () => {
        if (!ownerId || !credential.connectionId) return false;
        const refreshed = await refreshAntigravityCredential(secret);
        if (!refreshed || refreshed === secret) return false;
        secret = refreshed;
        token = antigravityAccessToken(secret)!;
        updateProviderConnection(credential.connectionId, ownerId, { secret, enabled: true });
        return true;
      };

      // Do not first spend a network round-trip on a token we already know is
      // expired. `agy models` only refreshes account metadata; it does not run a
      // model and therefore consumes no LLM tokens/quota.
      if (antigravityCredentialNeedsRefresh(secret)) {
        await refreshCredential();
      }

      let res = await readQuota(token);
      if ((res.status === 401 || res.status === 403) && await refreshCredential()) {
        res = await readQuota(token);
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const body = (await res.json()) as {
        models?: Record<string, { quotaInfo?: { remainingFraction?: number; resetTime?: string } }>;
      };
      const models = body.models ?? {};
      let soonestReset: string | null = null;
      let mostUsedPercent: number | null = null;
      let constrainedModel: string | null = null;
      for (const [id, model] of Object.entries(models)) {
        const reset = model.quotaInfo?.resetTime ?? null;
        if (reset && (!soonestReset || reset < soonestReset)) soonestReset = reset;
        const remaining = model.quotaInfo?.remainingFraction;
        if (typeof remaining === "number" && Number.isFinite(remaining)) {
          const used = Math.round((1 - remaining) * 100);
          if (mostUsedPercent === null || used > mostUsedPercent) {
            mostUsedPercent = used;
            constrainedModel = id;
          }
        }
      }
      return {
        ...base,
        ...(credential.connectionId ? { connectionId: credential.connectionId } : {}),
        windows: [{ label: "quota", usedPercent: mostUsedPercent, resetsAt: soonestReset }],
        extra: { models: Object.keys(models).length, mostConstrained: constrainedModel },
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "fetch failed";
    }
  }
  // Reaching this point means a credential exists. A rejected/expired token is
  // a refresh error, not "not connected". Reserve no_auth strictly for the
  // earlier zero-credential branch so the UI never lies about connection state.
  return { ...base, status: "error", error: lastError };
}

/* ---------------- Local gateway 5h stats ---------------- */

function fetchGateway5h(): UsageProvider[] {
  // Read-only access to the AiApi-Wrapper request log.
  // NOTE: created_at strings are ISO-8601 with "T" separators; the cutoff must
  // use the same format or string comparison overcounts.
  try {
    const db = new DatabaseSync(`file:${GATEWAY_DB}?mode=ro`, { open: true });
    const cutoff = new Date(Date.now() - 5 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "");
    const rows = db.prepare(
      `SELECT provider, model_alias, real_model, COUNT(*) as requests,
              SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) as tokens,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
       FROM requests WHERE created_at >= ?
       GROUP BY provider, model_alias, real_model
       ORDER BY requests DESC`,
    ).all(cutoff) as Array<{
      provider: string;
      model_alias: string;
      real_model: string;
      requests: number;
      tokens: number;
      errors: number;
    }>;
    db.close?.();
    return rows.map((row) => ({
      key: `gateway:${row.provider}:${row.model_alias}`,
      name: `Gateway · ${row.provider} · ${row.model_alias}`,
      status: "live" as const,
      source: "local" as const,
      windows: [],
      extra: {
        model: row.real_model || row.model_alias,
        requests5h: row.requests,
        tokens5h: row.tokens,
        errors5h: row.errors,
        telemetry: "local",
      },
    }));
  } catch {
    return [];
  }
}

function fetchMetisTelemetry5h(): UsageProvider[] {
  // Cursor and other SDK providers do not expose a portable usage/quota API.
  // Their completed runs are still represented by Metis' local model_signals
  // table. This is local telemetry, never presented as official provider quota.
  try {
    const db = getDatabase();
    const cutoff = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(
      `SELECT model_id, COUNT(*) AS requests,
              SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS tokens,
              SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors
       FROM model_signals
       WHERE created_at >= ?
       GROUP BY model_id
       ORDER BY requests DESC`,
    ).all(cutoff) as Array<{
      model_id: string;
      requests: number;
      tokens: number;
      errors: number;
    }>;
    return rows.map((row) => ({
      key: `local:${row.model_id}`,
      name: `Local · ${row.model_id}`,
      status: "live" as const,
      source: "local" as const,
      windows: [],
      extra: {
        model: row.model_id,
        requests5h: row.requests,
        tokens5h: row.tokens,
        errors5h: row.errors,
        telemetry: "local",
      },
    }));
  } catch {
    // model_signals is created lazily; absence is a normal first-run state.
    return [];
  }
}

/* ---------------- Cursor ---------------- */

function decodeJwtSub(token: string): string | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(json) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

function readCursorAppSession(): string | undefined {
  const envToken = process.env.CURSOR_SESSION_TOKEN || process.env.WORKOS_CURSOR_SESSION_TOKEN;
  if (envToken?.trim()) return envToken.trim();
  const home = homedir();
  const candidates = [
    path.join(home, ".config/Cursor/User/globalStorage/state.vscdb"),
    path.join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb"),
    path.join(home, "AppData/Roaming/Cursor/User/globalStorage/state.vscdb"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const db = new DatabaseSync(`file:${file}?mode=ro`, { open: true });
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken") as
        | { value?: string }
        | undefined;
      db.close();
      if (typeof row?.value === "string" && row.value.trim()) return row.value.trim();
    } catch {
      /* try next path */
    }
  }
  return undefined;
}

async function cursorFetchJson(url: string, token: string): Promise<unknown> {
  const sub = decodeJwtSub(token);
  const cookie = sub ? `${sub}::${token}` : token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        Cookie: `WorkosCursorSessionToken=${cookie}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCursorUsage(ownerId?: string): Promise<UsageProvider> {
  const base: UsageProvider = { key: "cursor", name: "Cursor", status: "live", windows: [], source: "dashboard" };
  const tokens: Array<{ token: string; connectionId?: string; apiKeyOnly?: boolean }> = [];
  if (ownerId) {
    for (const connection of listProviderConnections(ownerId, false).filter((item) => item.providerKey === "cursor")) {
      try {
        const secret = getProviderConnectionSecret(connection.id, ownerId)?.secret;
        if (secret?.trim() && !tokens.some((item) => item.token === secret.trim())) {
          tokens.push({ token: secret.trim(), connectionId: connection.id, apiKeyOnly: connection.authType === "api_key" });
        }
      } catch {
        /* try the next stored Cursor credential */
      }
    }
  }
  if (!ownerId) {
    const session = readCursorAppSession();
    if (session && !tokens.some((item) => item.token === session)) tokens.push({ token: session });
  }

  if (!tokens.length) return { ...base, status: "no_auth" };

  let lastError = "no usage payload";
  const urls = [
    "https://cursor.com/api/usage-summary",
    "https://www.cursor.com/api/usage-summary",
  ];
  for (const credential of tokens) {
    if (credential.apiKeyOnly) continue;
    for (const url of urls) {
      try {
        const body = await cursorFetchJson(url, credential.token);
        const parsed = parseCursorUsageBody(body);
        if (parsed) return {
          ...base,
          ...(credential.connectionId ? { connectionId: credential.connectionId } : {}),
          ...parsed,
        };
        lastError = "unsupported usage payload";
      } catch (error) {
        lastError = error instanceof Error ? error.message : "fetch failed";
      }
    }
  }
  const noAuth = /HTTP 401|HTTP 403/.test(lastError);
  if (tokens.every((credential) => credential.apiKeyOnly)) {
    return { ...base, status: "unsupported", error: "Cursor API keys provide model access, not dashboard quota." };
  }
  return { ...base, status: noAuth ? "no_auth" : "error", error: lastError };
}

/* ---------------- Aggregate + cache ---------------- */

export function preserveUsageOnTransientFailure(
  previous: UsageProvider | undefined,
  next: UsageProvider,
): UsageProvider {
  if (next.status !== "error" || !previous || !windowsWithUsableQuota(previous.windows)) return next;
  return {
    ...previous,
    status: "stale",
    error: next.error || "Live quota refresh failed; showing the last known value.",
  };
}

function windowsWithUsableQuota(windows: UsageWindow[]) {
  return windows.some((window) => typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent));
}

function mergeWithPrevious(previous: UsageSnapshot | undefined, next: UsageSnapshot): UsageSnapshot {
  if (!previous) return next;
  const oldByKey = new Map(previous.providers.map((provider) => [provider.key, provider]));
  return {
    ...next,
    providers: next.providers.map((provider) => preserveUsageOnTransientFailure(oldByKey.get(provider.key), provider)),
  };
}

async function collect(ownerId?: string): Promise<UsageSnapshot> {
  const sources = [
    { key: "cursor", name: "Cursor", load: fetchCursorUsage },
    { key: "codex", name: "Codex (ChatGPT plan)", load: fetchCodexUsage },
    { key: "zai", name: "z.ai Coding Plan", load: fetchZaiUsage },
    { key: "antigravity", name: "Antigravity", load: fetchAntigravityUsage },
  ] as const;
  const results = await Promise.allSettled(sources.map(({ load }) => load(ownerId)));
  const providers: UsageProvider[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      providers.push(result.value);
      return;
    }
    const error = result.reason instanceof Error ? result.reason.message : String(result.reason || "provider lookup failed");
    providers.push({
      key: sources[index].key,
      name: sources[index].name,
      status: "error",
      windows: [],
      error,
    });
  });
  providers.push(...fetchGateway5h());
  providers.push(...fetchMetisTelemetry5h());
  return { providers, fetchedAt: new Date().toISOString() };
}

function refreshPlanUsage(key: string, ownerId?: string) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const request = collect(ownerId)
    .then((snapshot) => {
      const merged = mergeWithPrevious(cache.get(key), snapshot);
      cache.set(key, merged);
      persistUsage(ownerId, merged);
      return merged;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

export async function getPlanUsage(force = false, ownerId?: string): Promise<UsageSnapshot> {
  const key = ownerId || "global";
  let cached = cache.get(key);
  if (!cached && !force) {
    cached = loadPersistedUsage(ownerId) || undefined;
    if (cached) cache.set(key, cached);
  }
  const age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY;

  if (!force && cached && age < CACHE_TTL_MS) return cached;

  // Any last-known value is renderable immediately, even after a process
  // restart/deploy. Refresh in the background instead of making the composer
  // wait on several unrelated provider dashboards. This performs zero model
  // generations and therefore consumes no LLM tokens.
  if (!force && cached) {
    void refreshPlanUsage(key, ownerId);
    return { ...cached, refreshing: true };
  }

  // First-ever load has no value to restore. Return a deterministic placeholder
  // immediately and let the client follow the refreshing flag until the shared
  // server refresh completes.
  if (!force) {
    void refreshPlanUsage(key, ownerId);
    return { providers: [], fetchedAt: new Date().toISOString(), refreshing: true };
  }

  return refreshPlanUsage(key, ownerId);
}
