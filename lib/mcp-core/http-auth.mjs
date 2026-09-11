import { timingSafeEqual } from "node:crypto";
import { verifyTrustedMcpSession } from "./session-token.mjs";

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function trustedSessionContextFromBearer(rawToken, secret = process.env.MCP_BEARER_TOKEN) {
  const claims = verifyTrustedMcpSession(rawToken, String(secret || "").trim());
  if (!claims) return null;
  return {
    transport: "http",
    trustedInternal: true,
    chatId: typeof claims.chatId === "string" ? claims.chatId : undefined,
    userId: claims.userId,
    jobId: typeof claims.jobId === "string" ? claims.jobId : undefined,
    workerId: typeof claims.workerId === "string" ? claims.workerId : undefined,
    leaseToken: typeof claims.leaseToken === "string" ? claims.leaseToken : undefined,
    incognito: claims.incognito === true,
    automation: claims.automation === true,
    modeId: typeof claims.modeId === "string" ? claims.modeId : undefined,
    runtimeMode: typeof claims.runtimeMode === "string" ? claims.runtimeMode : undefined,
    modePolicy: typeof claims.modePolicy === "string" ? claims.modePolicy : undefined,
    compressionEnabled: claims.compressionEnabled === true,
    compressionMode: typeof claims.compressionMode === "string" ? claims.compressionMode : undefined,
    compressionToolResults: typeof claims.compressionToolResults === "boolean" ? claims.compressionToolResults : undefined,
    capabilityManifest: typeof claims.capabilityManifest === "string" ? claims.capabilityManifest : undefined,
    capabilityHash: typeof claims.capabilityHash === "string" ? claims.capabilityHash : undefined,
    osUsername: typeof claims.osUsername === "string" ? claims.osUsername : "",
    uid: claims.uid,
    gid: claims.gid,
    workspaceRoot: claims.workspaceRoot,
    home: claims.home,
    allowRoot: claims.allowRoot === true,
    isHostAdmin: claims.isHostAdmin === true,
  };
}

export function requestAuthorization(req, secret = process.env.MCP_BEARER_TOKEN) {
  const supplied = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const trustedContext = trustedSessionContextFromBearer(supplied, secret);
  if (trustedContext) return { ok: true, trustedContext };

  if (supplied.startsWith("metis-v1.")) {
    return { ok: false, trustedContext: null };
  }

  const configured = String(secret || "").trim();
  if (supplied) {
    return { ok: safeEqualText(configured, supplied), trustedContext: null };
  }

  // Localhost is a bind address, not authentication. Unauthenticated callers
  // (including 127.0.0.1) must be rejected so other OS users and the server
  // browser cannot talk to the gateway as root.
  return { ok: false, trustedContext: null };
}

export function corsAllowedOrigins({
  internalOrigin = process.env.AI_CHAT_INTERNAL_ORIGIN || process.env.AI_CHAT_PUBLIC_URL || "",
  extra = process.env.MCP_CORS_ORIGIN || "",
} = {}) {
  const origins = new Set();
  for (const value of [internalOrigin, extra]) {
    const origin = String(value || "").trim().replace(/\/+$/, "");
    if (origin) origins.add(origin);
  }
  return origins;
}

export function corsAllowOrigin(requestOrigin, allowed = corsAllowedOrigins()) {
  const origin = String(requestOrigin || "").trim().replace(/\/+$/, "");
  if (!origin) return null;
  return allowed.has(origin) ? origin : null;
}
