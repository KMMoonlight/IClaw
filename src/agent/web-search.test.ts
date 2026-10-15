import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../config.js";
import { MAX_SEARCH_RESULTS, searchEnabled, searchWeb } from "./web-search.js";

const KEYS = ["ICLAW_SEARCH_PROVIDER", "ICLAW_SEARCH_API_KEY", "ICLAW_SEARCH_BASE_URL"] as const;
const saved = new Map<string, string | undefined>();
for (const k of KEYS) saved.set(k, process.env[k]);

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  for (const k of KEYS) setEnv(k, undefined);
  resetConfigCache();
});

afterEach(() => {
  for (const k of KEYS) setEnv(k, saved.get(k));
  resetConfigCache();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("searchEnabled", () => {
  it("is false by default and true when a provider is set", () => {
    expect(searchEnabled()).toBe(false);
    setEnv("ICLAW_SEARCH_PROVIDER", "searxng");
    setEnv("ICLAW_SEARCH_BASE_URL", "https://searx.example");
    resetConfigCache();
    expect(searchEnabled()).toBe(true);
  });
});

describe("searchWeb", () => {
  it("throws when unconfigured", async () => {
    await expect(searchWeb("hello")).rejects.toThrow("未配置");
  });

  it("queries tavily and parses results", async () => {
    setEnv("ICLAW_SEARCH_PROVIDER", "tavily");
    setEnv("ICLAW_SEARCH_API_KEY", "tv-key");
    resetConfigCache();
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          { title: "A", url: "https://a.example", content: "snippet a" },
          { title: "B", url: "https://b.example", content: "snippet b" },
          { title: "no-url" },
        ],
      }),
    ) as unknown as typeof fetch;
    const results = await searchWeb("query", { fetchImpl });
    expect(results).toEqual([
      { title: "A", url: "https://a.example", snippet: "snippet a" },
      { title: "B", url: "https://b.example", snippet: "snippet b" },
    ]);
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toBe(
      "https://api.tavily.com/search",
    );
  });

  it("requires the tavily api key", async () => {
    setEnv("ICLAW_SEARCH_PROVIDER", "tavily");
    resetConfigCache();
    await expect(searchWeb("q")).rejects.toThrow("ICLAW_SEARCH_API_KEY");
  });

  it("queries brave with the subscription header", async () => {
    setEnv("ICLAW_SEARCH_PROVIDER", "brave");
    setEnv("ICLAW_SEARCH_API_KEY", "brave-key");
    resetConfigCache();
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ web: { results: [{ title: "C", url: "https://c.example", description: "d" }] } }),
    ) as unknown as typeof fetch;
    const results = await searchWeb("q", { fetchImpl });
    expect(results).toEqual([{ title: "C", url: "https://c.example", snippet: "d" }]);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toContain("api.search.brave.com/res/v1/web/search");
    expect((init.headers as Record<string, string>)["x-subscription-token"]).toBe("brave-key");
  });

  it("queries a searxng instance and caps the result count", async () => {
    setEnv("ICLAW_SEARCH_PROVIDER", "searxng");
    setEnv("ICLAW_SEARCH_BASE_URL", "https://searx.example/");
    resetConfigCache();
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, url: `https://x/${i}`, content: "c" }));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: many })) as unknown as typeof fetch;
    const results = await searchWeb("q", { fetchImpl, count: 99 });
    expect(results).toHaveLength(MAX_SEARCH_RESULTS);
    const [url] = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]!;
    expect(url).toContain("https://searx.example/search?q=q&format=json");
  });

  it("requires the searxng base url", async () => {
    setEnv("ICLAW_SEARCH_PROVIDER", "searxng");
    resetConfigCache();
    await expect(searchWeb("q")).rejects.toThrow("ICLAW_SEARCH_BASE_URL");
  });

  it("surfaces HTTP errors", async () => {
    setEnv("ICLAW_SEARCH_PROVIDER", "searxng");
    setEnv("ICLAW_SEARCH_BASE_URL", "https://searx.example");
    resetConfigCache();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(searchWeb("q", { fetchImpl })).rejects.toThrow("500");
  });
});
