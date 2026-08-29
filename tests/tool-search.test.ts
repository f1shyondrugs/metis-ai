import assert from "node:assert/strict";
import test from "node:test";
import {
  compactToolMatch,
  mapWithConcurrency,
  rankToolMatches,
  scoreToolHaystack,
  toolSearchHaystack,
  withOverallBudget,
  withTimeout,
} from "../lib/mcp-core/tool-search.mjs";
import { localWebSearch } from "../lib/mcp-core/local-search.mjs";

test("scoreToolHaystack counts overlapping query words", () => {
  assert.equal(scoreToolHaystack("github issues", "github github issues"), 2);
  assert.equal(scoreToolHaystack("figma", "vercel deploy"), 0);
});

test("rankToolMatches sorts by score then server/name and omits schemas", () => {
  const ranked = rankToolMatches([
    { server: "b", name: "z", score: 1 },
    { server: "a", name: "a", score: 2 },
    { server: "a", name: "b", score: 2 },
  ], 2);
  assert.deepEqual(ranked.map((item) => `${item.server}:${item.name}`), ["a:a", "a:b"]);
});

test("compactToolMatch truncates descriptions and drops inputSchema", () => {
  const match = compactToolMatch(
    { id: "github" },
    { name: "list_issues", description: "x".repeat(400), inputSchema: { type: "object" } },
    2,
  );
  assert.equal(match.description.length, 240);
  assert.equal("inputSchema" in match, false);
});

test("toolSearchHaystack does not stringify schemas", () => {
  const haystack = toolSearchHaystack(
    { id: "playwright", name: "browser", tags: ["web"] },
    { name: "browser_navigate", description: "open a url", inputSchema: { huge: true } },
  );
  assert.match(haystack, /playwright/);
  assert.match(haystack, /browser_navigate/);
  assert.doesNotMatch(haystack, /huge/);
});

test("mapWithConcurrency preserves order with a low worker cap", async () => {
  const seen: number[] = [];
  const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    seen.push(value);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return value * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40]);
  assert.equal(seen.length, 4);
});

test("withTimeout rejects slow work", async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => undefined), 20, "slow"),
    /slow/,
  );
});

test("withOverallBudget returns partial fallback instead of hanging", async () => {
  const result = await withOverallBudget(
    new Promise<never>(() => undefined),
    20,
    (reason) => ({ tools: [], errors: [{ server: "*", error: reason }] }),
  );
  assert.equal(result.errors[0].error, "search_budget_exceeded");
});

test("localWebSearch queries SearXNG JSON and normalizes results", async () => {
  let requestedUrl = "";
  const result = await localWebSearch({
    query: "Kleinanzeigen Leipzig Server",
    numResults: 1,
    endpoint: "http://127.0.0.1:8888/search",
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        results: [
          { title: "Server", url: "https://example.test/server", content: "32 GB RAM", engine: "brave" },
          { title: "Second", url: "https://example.test/second" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.match(requestedUrl, /q=Kleinanzeigen\+Leipzig\+Server/);
  assert.equal(result.source, "local-searxng");
  assert.deepEqual(result.results, [{
    title: "Server",
    url: "https://example.test/server",
    content: "32 GB RAM",
    engine: "brave",
  }]);
});

import { localWebFetch } from "../lib/mcp-core/local-scraper.mjs";

test("localWebFetch sends bounded URL batches to the local scraper", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await localWebFetch({
    urls: ["https://example.com/a", "https://example.com/b"],
    endpoint: "http://127.0.0.1:8890/fetch",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        ok: true,
        source: "local-scrapling-static",
        results: [
          { ok: true, source: "local-scrapling-static", url: "https://example.com/a", content: "A" },
          { ok: true, source: "local-scrapling-static", url: "https://example.com/b", content: "B" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8890/fetch");
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(body.urls, ["https://example.com/a", "https://example.com/b"]);
  assert.equal(result.results.length, 2);
});

test("localWebSearch falls back to the local Scrapling search parser when SearXNG is down", async () => {
  const calls: string[] = [];
  const result = await localWebSearch({
    query: "OpenAI",
    numResults: 2,
    endpoint: "http://127.0.0.1:8888/search",
    scraperEndpoint: "http://127.0.0.1:8890/search",
    fetchImpl: async (input, init) => {
      calls.push(String(input));
      if (calls.length === 1) throw new Error("searx offline");
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({
        source: "local-scrapling-bing",
        query: "OpenAI",
        results: [
          { title: "OpenAI", url: "https://openai.com/", content: "Research", engine: "bing" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(calls, ["http://127.0.0.1:8888/search?q=OpenAI&format=json&categories=general&pageno=1", "http://127.0.0.1:8890/search"]);
  assert.equal(result.source, "local-scrapling-bing");
  assert.equal(result.results[0].url, "https://openai.com/");
});
