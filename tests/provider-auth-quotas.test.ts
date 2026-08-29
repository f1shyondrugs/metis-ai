import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBaseUrl,
  parseDiscoveredModel,
  discoverProviderModels,
  readCodexOAuthCredentials,
} from "../lib/providers/discovery";
import {
  antigravityCredentialNeedsRefresh,
  codexWindowLabel,
  normalizeCodexWindow,
  preserveUsageOnTransientFailure,
  readCodexUsageOAuthCredentials,
} from "../lib/plan-usage";
import type { ProviderConnectionWithSecret } from "../lib/provider-connections";

function codexSecret(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      idToken: "id-token",
      accountId: "account-1",
      expires: Date.now() + 60_000,
      ...overrides,
    },
  });
}

test("Codex OAuth validates all required credential fields and expiry", () => {
  const credentials = readCodexOAuthCredentials(codexSecret());
  assert.equal(credentials.accountId, "account-1");
  assert.throws(
    () => readCodexOAuthCredentials(codexSecret({ idToken: undefined })),
    /access, refresh, idToken, accountId, and expiry/,
  );
  assert.throws(
    () => readCodexOAuthCredentials(codexSecret({ expires: Date.now() - 1 })),
    /expired/,
  );
  assert.doesNotThrow(() =>
    readCodexOAuthCredentials(codexSecret({ expires: Date.now() - 1 }), { allowExpired: true }),
  );
});

test("custom discovery normalizes base URLs, auth variants, and model formats", async () => {
  assert.equal(normalizeBaseUrl("https://example.test/v1///?ignored=1"), "https://example.test/v1");
  assert.deepEqual(parseDiscoveredModel({ name: "models/demo", displayName: "Demo" }), {
    id: "demo",
    displayName: "Demo",
  });

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), headers });
    if (headers.get("Authorization")) return new Response("unauthorized", { status: 401 });
    return Response.json({ data: [{ id: "custom-model", display_name: "Custom Model" }] });
  };
  try {
    const connection = {
      id: "connection-1",
      ownerId: "owner-1",
      providerKey: "compatible",
      slug: "custom",
      label: "Custom",
      authType: "api_key",
      baseUrl: "https://example.test/v1/",
      config: {},
      enabled: true,
      hasSecret: true,
      secret: "secret",
      secretHint: "configured",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies ProviderConnectionWithSecret;
    const models = await discoverProviderModels(connection);
    assert.equal(models.some((model) => model.id === "custom-model"), true);
    assert.equal(requests[0]?.url, "https://example.test/v1/models");
    assert.equal(requests.some(({ headers }) => headers.get("x-api-key") === "secret"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("Antigravity quota refreshes expired OAuth credentials before querying quota", () => {
  const expired = JSON.stringify({
    token: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      expiry: new Date(Date.now() - 60_000).toISOString(),
    },
    auth_method: "consumer",
  });
  const healthy = JSON.stringify({
    token: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      expiry: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
    auth_method: "consumer",
  });
  assert.equal(antigravityCredentialNeedsRefresh(expired), true);
  assert.equal(antigravityCredentialNeedsRefresh(healthy), false);
});

test("Codex quota windows preserve five-hour and weekly reset data", () => {
  assert.equal(codexWindowLabel(300), "5h");
  assert.equal(codexWindowLabel(10080), "weekly");
  const window = normalizeCodexWindow({
    used_percent: 42,
    windowDurationSeconds: 300 * 60,
    resetAt: 1_900_000_000,
  });
  assert.deepEqual(window, {
    label: "5h",
    usedPercent: 42,
    resetsAt: new Date(1_900_000_000 * 1_000).toISOString(),
  });
});

test("Codex quota can bootstrap from refreshable OAuth credentials after access expiry", () => {
  const credentials = readCodexUsageOAuthCredentials(codexSecret({ expires: Date.now() - 1 }));
  assert.equal(credentials.refresh, "refresh-token");
  assert.equal(credentials.accountId, "account-1");
});


test("quota refresh keeps the last valid value on transient provider failure", () => {
  const previous = {
    key: "zai",
    name: "z.ai Coding Plan",
    status: "live" as const,
    windows: [{ label: "5h", usedPercent: 34, resetsAt: null }],
  };
  const next = {
    key: "zai",
    name: "z.ai Coding Plan",
    status: "error" as const,
    windows: [],
    error: "fetch failed",
  };
  const preserved = preserveUsageOnTransientFailure(previous, next);
  assert.equal(preserved.status, "stale");
  assert.equal(preserved.windows[0]?.usedPercent, 34);
  assert.equal(preserved.error, "fetch failed");
});
