import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../config.js";
import { cosineSimilarity, embedText, embedTexts, embeddingsEnabled, resolveEmbeddingEndpoint } from "./embedding.js";

const KEYS = [
  "ICLAW_MODEL_PROVIDER",
  "ICLAW_MODEL_BASE_URL",
  "ICLAW_API_KEY",
  "ICLAW_EMBEDDING_MODEL",
  "ICLAW_EMBEDDING_BASE_URL",
  "OPENAI_API_KEY",
] as const;
const saved = new Map<string, string | undefined>();
for (const k of KEYS) saved.set(k, process.env[k]);

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  for (const k of KEYS) setEnv(k, undefined);
  setEnv("ICLAW_MODEL_PROVIDER", "openai");
  setEnv("ICLAW_API_KEY", "sk-test");
  resetConfigCache();
});

afterEach(() => {
  for (const k of KEYS) setEnv(k, saved.get(k));
  resetConfigCache();
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical direction and 0 for orthogonal", () => {
    expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3]))).toBeCloseTo(1);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
  });

  it("clamps negative similarity and handles zero vectors", () => {
    expect(cosineSimilarity(new Float32Array([1, 1]), new Float32Array([-1, -1]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });

  it("handles mismatched lengths using the shorter vector", () => {
    expect(cosineSimilarity(new Float32Array([1, 0, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
  });
});

describe("configuration", () => {
  it("is disabled without ICLAW_EMBEDDING_MODEL", () => {
    expect(embeddingsEnabled()).toBe(false);
    expect(resolveEmbeddingEndpoint()).toBeNull();
  });

  it("resolves the endpoint from the provider base URL", () => {
    setEnv("ICLAW_EMBEDDING_MODEL", "text-embedding-3-small");
    setEnv("ICLAW_MODEL_BASE_URL", "https://example.com/v1");
    resetConfigCache();
    expect(embeddingsEnabled()).toBe(true);
    expect(resolveEmbeddingEndpoint()).toBe("https://example.com/v1/embeddings");
  });

  it("prefers the explicit embedding base URL and strips trailing slashes", () => {
    setEnv("ICLAW_EMBEDDING_MODEL", "emb");
    setEnv("ICLAW_MODEL_BASE_URL", "https://example.com/v1");
    setEnv("ICLAW_EMBEDDING_BASE_URL", "https://embed.example.com/v2/");
    resetConfigCache();
    expect(resolveEmbeddingEndpoint()).toBe("https://embed.example.com/v2/embeddings");
  });

  it("falls back to the provider built-in base URL", () => {
    setEnv("ICLAW_EMBEDDING_MODEL", "emb");
    resetConfigCache();
    expect(resolveEmbeddingEndpoint()).toBe("https://api.openai.com/v1/embeddings");
  });
});

describe("embedTexts", () => {
  it("posts an OpenAI-compatible request and parses vectors", async () => {
    setEnv("ICLAW_EMBEDDING_MODEL", "text-embedding-3-small");
    setEnv("ICLAW_MODEL_BASE_URL", "https://example.com/v1");
    resetConfigCache();

    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const vectors = await embedTexts(["a", "b"], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(vectors).toHaveLength(2);
    expect(vectors[0]![0]).toBeCloseTo(0.1);
    expect(vectors[0]![1]).toBeCloseTo(0.2);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://example.com/v1/embeddings");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe("Bearer sk-test");
    expect(JSON.parse((init as { body: string }).body)).toEqual({
      model: "text-embedding-3-small",
      input: ["a", "b"],
    });
  });

  it("throws on HTTP errors and vector-count mismatch", async () => {
    setEnv("ICLAW_EMBEDDING_MODEL", "emb");
    setEnv("ICLAW_MODEL_BASE_URL", "https://example.com/v1");
    resetConfigCache();

    await expect(
      embedTexts(["a"], { fetchImpl: vi.fn().mockResolvedValue(new Response("nope", { status: 500 })) as unknown as typeof fetch }),
    ).rejects.toThrow("500");

    await expect(
      embedTexts(["a", "b"], {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 }),
        ) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("expected 2");
  });

  it("throws when embeddings are not configured", async () => {
    await expect(embedTexts(["a"])).rejects.toThrow("not configured");
  });

  it("returns an empty list without calling the network", async () => {
    const fetchImpl = vi.fn();
    expect(await embedTexts([], { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("embedText returns the first vector", async () => {
    setEnv("ICLAW_EMBEDDING_MODEL", "emb");
    setEnv("ICLAW_MODEL_BASE_URL", "https://example.com/v1");
    resetConfigCache();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: [0.5, 0.5] }] }), { status: 200 }));
    const vec = await embedText("hello", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(Array.from(vec)).toEqual([0.5, 0.5]);
  });
});
