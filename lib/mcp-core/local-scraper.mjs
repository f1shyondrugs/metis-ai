const DEFAULT_TIMEOUT_MS = 20_000;

function endpointFromEnv() {
  return process.env.MCP_LOCAL_SCRAPER_URL?.trim() || "http://127.0.0.1:8890/fetch";
}

export async function localWebFetch({
  url,
  urls,
  endpoint = endpointFromEnv(),
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxChars = 40_000,
} = {}) {
  const targets = Array.isArray(urls) ? urls : url ? [url] : [];
  if (!targets.length) throw new Error("url or urls is required");
  if (targets.length > 8) throw new Error("web_fetch accepts at most 8 URLs per call");
  if (!endpoint) throw new Error("MCP_LOCAL_SCRAPER_URL is not configured");
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ urls: targets, maxChars }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`local scraper returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.results)) throw new Error("local scraper returned an invalid payload");
    return payload;
  } finally {
    clearTimeout(timer);
  }
}
