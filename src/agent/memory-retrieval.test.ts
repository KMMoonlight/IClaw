import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../config.js";
import { addMemory, createUser, getMemory, openDbInMemory } from "../db/index.js";
import type { Memory } from "../db/index.js";
import {
  keywordScore,
  rankByKeywords,
  rankByVectors,
  retrieveMemories,
  selectWithinBudget,
  tokenize,
} from "./memory-retrieval.js";
import type { EmbedFn } from "./memory-retrieval.js";

const KEYS = ["ICLAW_EMBEDDING_MODEL", "ICLAW_MODEL_BASE_URL", "ICLAW_MODEL_PROVIDER", "ICLAW_API_KEY"] as const;
const saved = new Map<string, string | undefined>();
for (const k of KEYS) saved.set(k, process.env[k]);

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  openDbInMemory();
  for (const k of KEYS) setEnv(k, undefined);
  setEnv("ICLAW_MODEL_PROVIDER", "openai");
  setEnv("ICLAW_API_KEY", "sk-test");
  resetConfigCache();
});

afterEach(() => {
  for (const k of KEYS) setEnv(k, saved.get(k));
  resetConfigCache();
});

function mem(content: string, importance = 0.5, createdAt = 0, kind = "fact"): Memory {
  return {
    id: content,
    userId: "u",
    kind,
    content,
    source: "user",
    importance,
    createdAt,
    updatedAt: createdAt,
    lastUsedAt: null,
    hasEmbedding: false,
  };
}

describe("tokenize", () => {
  it("keeps latin words and expands CJK into bigrams", () => {
    expect(tokenize("Hello World 123")).toEqual(["hello", "world", "123"]);
    expect(tokenize("咖啡")).toEqual(["咖啡"]);
    expect(tokenize("我喜欢咖啡")).toEqual(["我喜", "喜欢", "欢咖", "咖啡"]);
    expect(tokenize("单")).toEqual(["单"]);
  });
});

describe("keywordScore", () => {
  it("scores overlapping content higher than unrelated content", () => {
    const query = new Set(tokenize("咖啡"));
    const related = keywordScore(query, "用户喜欢喝美式咖啡");
    const unrelated = keywordScore(query, "用户住在上海");
    expect(related).toBeGreaterThan(0);
    expect(unrelated).toBe(0);
  });

  it("returns 0 for an empty query", () => {
    expect(keywordScore(new Set(), "anything")).toBe(0);
  });
});

describe("rankByKeywords", () => {
  it("orders by lexical overlap then importance", () => {
    const ranked = rankByKeywords([mem("住在上海"), mem("喜欢咖啡"), mem("喝咖啡")], "咖啡");
    expect(ranked[0]!.memory.content).toContain("咖啡");
    expect(ranked[ranked.length - 1]!.memory.content).toBe("住在上海");
  });
});

describe("rankByVectors", () => {
  it("orders by cosine similarity", () => {
    const memories = [mem("a"), mem("b")];
    const vectors = new Map([
      ["a", new Float32Array([0, 1])],
      ["b", new Float32Array([1, 0])],
    ]);
    const ranked = rankByVectors(memories, new Float32Array([1, 0]), vectors);
    expect(ranked[0]!.memory.id).toBe("b");
  });
});

describe("selectWithinBudget", () => {
  it("keeps at least one item and stops at the budget", () => {
    const ranked = [{ memory: mem("x".repeat(500)), score: 1 }, { memory: mem("y"), score: 0.5 }];
    expect(selectWithinBudget(ranked, 10)).toHaveLength(1);
  });
});

describe("retrieveMemories", () => {
  it("returns an empty result when the user has no memories", async () => {
    const u = createUser("u");
    expect(await retrieveMemories(u.id, "咖啡")).toEqual({ memories: [], mode: "keyword" });
  });

  it("uses keyword ranking when embeddings are not configured", async () => {
    const u = createUser("u");
    addMemory(u.id, "用户喜欢喝美式咖啡");
    addMemory(u.id, "用户住在上海");
    const result = await retrieveMemories(u.id, "要不要喝点咖啡？");
    expect(result.mode).toBe("keyword");
    expect(result.memories[0]!.content).toContain("咖啡");
  });

  it("uses vector ranking and lazily persists embeddings when configured", async () => {
    setEnv("ICLAW_EMBEDDING_MODEL", "emb");
    setEnv("ICLAW_MODEL_BASE_URL", "https://example.com/v1");
    resetConfigCache();

    const u = createUser("u");
    const coffee = addMemory(u.id, "喜欢喝美式咖啡");
    const shanghai = addMemory(u.id, "住在上海");

    const vectors: Record<string, number[]> = {
      "要不要喝咖啡": [1, 0],
      "喜欢喝美式咖啡": [0.9, 0.1],
      "住在上海": [0, 1],
    };
    const embed: EmbedFn = async (text) => Float32Array.from(vectors[text] ?? [0, 0]);

    const result = await retrieveMemories(u.id, "要不要喝咖啡", { embed });
    expect(result.mode).toBe("vector");
    expect(result.memories[0]!.id).toBe(coffee.id);
    // Embeddings are backfilled and stored for reuse.
    expect(getMemory(coffee.id)!.hasEmbedding).toBe(true);
    expect(getMemory(shanghai.id)!.hasEmbedding).toBe(true);
  });

  it("degrades to keywords when the embedding call fails", async () => {
    setEnv("ICLAW_EMBEDDING_MODEL", "emb");
    setEnv("ICLAW_MODEL_BASE_URL", "https://example.com/v1");
    resetConfigCache();

    const u = createUser("u");
    addMemory(u.id, "喜欢喝咖啡");
    addMemory(u.id, "住在上海");
    const embed: EmbedFn = async () => {
      throw new Error("upstream down");
    };
    const result = await retrieveMemories(u.id, "咖啡", { embed });
    expect(result.mode).toBe("keyword");
    expect(result.memories[0]!.content).toContain("咖啡");
  });

  it("prefers keywords for an empty query even when embeddings are configured", async () => {
    setEnv("ICLAW_EMBEDDING_MODEL", "emb");
    setEnv("ICLAW_MODEL_BASE_URL", "https://example.com/v1");
    resetConfigCache();
    const u = createUser("u");
    addMemory(u.id, "重要事实", { importance: 1 });
    const result = await retrieveMemories(u.id, "   ", { embed: async () => new Float32Array([1, 0]) });
    expect(result.mode).toBe("keyword");
    expect(result.memories).toHaveLength(1);
  });
});
