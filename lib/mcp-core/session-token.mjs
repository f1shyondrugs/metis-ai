import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "metis-v1";

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function signTrustedMcpSession(claims, secret) {
  const key = String(secret || "").trim();
  if (!key) throw new Error("MCP_BEARER_TOKEN is required for trusted HTTP MCP sessions.");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `${PREFIX}.${payload}.${signature}`;
}

export function verifyTrustedMcpSession(token, secret, now = Date.now()) {
  const key = String(secret || "").trim();
  const raw = String(token || "").trim();
  if (!key || !raw.startsWith(`${PREFIX}.`)) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [, payload, suppliedSignature] = parts;
  const expectedSignature = createHmac("sha256", key).update(payload).digest("base64url");
  if (!safeEqual(expectedSignature, suppliedSignature)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || claims.v !== 1 || claims.trustedInternal !== true) return null;
  if (!Number.isFinite(claims.exp) || claims.exp < now) return null;
  if (typeof claims.userId !== "string" || !claims.userId.trim()) return null;
  if (!Number.isInteger(claims.uid) || claims.uid < 0) return null;
  if (!Number.isInteger(claims.gid) || claims.gid < 0) return null;
  if (typeof claims.workspaceRoot !== "string" || !claims.workspaceRoot.trim()) return null;
  if (typeof claims.home !== "string" || !claims.home.trim()) return null;
  return claims;
}
