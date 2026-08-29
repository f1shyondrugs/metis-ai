export type LocalSearchResult = {
  title: string;
  url: string;
  content: string;
  engine: string;
};

export type LocalWebSearchResponse = {
  source: "local-searxng" | "local-scrapling-bing";
  query: string;
  results: LocalSearchResult[];
};

export function localWebSearch(options?: {
  query?: string;
  numResults?: number;
  endpoint?: string;
  scraperEndpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<LocalWebSearchResponse>;
export type LocalSearchResult = {
  title: string;
  url: string;
  content: string;
  engine: string;
};

export type LocalSearchResponse = {
  source: string;
  query: string;
  results: LocalSearchResult[];
};

export type LocalSearchOptions = {
  query: string;
  numResults?: number;
  endpoint?: string;
  scraperEndpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function localWebSearch(options: LocalSearchOptions): Promise<LocalSearchResponse>;
