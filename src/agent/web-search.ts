import { loadConfig } from "../config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  count?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const MAX_SEARCH_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 15_000;

/** Whether a search backend is configured. */
export function searchEnabled(): boolean {
  return loadConfig().searchProvider !== "none";
}

async function getJson(
  url: string,
  init: RequestInit,
  opts: SearchOptions,
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? SEARCH_TIMEOUT_MS);
  opts.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`搜索请求失败：HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function clampCount(count: number | undefined): number {
  return Math.min(MAX_SEARCH_RESULTS, Math.max(1, count ?? 5));
}

type Adapter = (query: string, count: number, opts: SearchOptions) => Promise<SearchResult[]>;

const tavily: Adapter = async (query, count, opts) => {
  const cfg = loadConfig();
  if (!cfg.searchApiKey) throw new Error("tavily 需要 ICLAW_SEARCH_API_KEY");
  const base = cfg.searchBaseUrl ?? "https://api.tavily.com";
  const data = (await getJson(
    `${base.replace(/\/+$/, "")}/search`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: cfg.searchApiKey, query, max_results: count }),
    },
    opts,
  )) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "" }));
};

const brave: Adapter = async (query, count, opts) => {
  const cfg = loadConfig();
  if (!cfg.searchApiKey) throw new Error("brave 需要 ICLAW_SEARCH_API_KEY");
  const base = cfg.searchBaseUrl ?? "https://api.search.brave.com";
  const url = `${base.replace(/\/+$/, "")}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const data = (await getJson(url, { headers: { accept: "application/json", "x-subscription-token": cfg.searchApiKey } }, opts)) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.description ?? "" }));
};

const searxng: Adapter = async (query, count, opts) => {
  const cfg = loadConfig();
  if (!cfg.searchBaseUrl) throw new Error("searxng 需要 ICLAW_SEARCH_BASE_URL");
  const url = `${cfg.searchBaseUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  const data = (await getJson(url, { headers: { accept: "application/json" } }, opts)) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results ?? []).slice(0, count).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "" }));
};

const ADAPTERS: Record<string, Adapter> = { tavily, brave, searxng };

/** Run a web search through the configured backend. Throws when unconfigured. */
export async function searchWeb(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const provider = loadConfig().searchProvider;
  if (provider === "none") throw new Error("web_search 未配置（设置 ICLAW_SEARCH_PROVIDER）");
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`未知搜索 provider：${provider}`);
  const results = await adapter(query, clampCount(options.count), options);
  return results.filter((r) => r.url);
}
