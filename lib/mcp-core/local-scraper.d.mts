export type LocalScrapeResult = {
  ok: boolean;
  source: "local-scrapling-static";
  url: string;
  finalUrl?: string;
  status?: number;
  title?: string;
  contentType?: string;
  content?: string;
  elapsedMs?: number;
  requiresBrowser?: boolean;
  routingHint?: string;
  error?: string;
};

export function localWebFetch(options: {
  url?: string;
  urls?: string[];
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<{ ok: boolean; source: "local-scrapling-static"; results: LocalScrapeResult[] }>;
