import { getMemoryEmbedding, listMemories, setMemoryEmbedding } from "../db/index.js";
import type { Memory } from "../db/index.js";
import { logger } from "../logger.js";
import { cosineSimilarity, embedText, embeddingsEnabled } from "./embedding.js";
import { MAX_MEMORY_PROMPT_CHARS } from "./memory.js";

export type RetrievalMode = "vector" | "keyword";

export interface RetrievalResult {
  memories: Memory[];
  mode: RetrievalMode;
}

/** Text → embedding vector. Injectable so retrieval can be tested without a model. */
export type EmbedFn = (text: string) => Promise<Float32Array>;

/** Cap how many missing embeddings we compute per turn (lazy backfill). */
export const MAX_BACKFILL_PER_TURN = 32;

export interface RetrievalOptions {
  budget?: number;
  embed?: EmbedFn;
  now?: number;
}

/**
 * Tokenize for keyword retrieval. English/number words are kept whole; CJK runs
 * are expanded into character bigrams (and a single char when the run is short),
 * which gives usable lexical matching without a segmenter.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = lower.match(/[a-z0-9]+/g) ?? [];
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

/** Lexical overlap, length-normalised so long memories don't dominate. */
export function keywordScore(queryTokens: Set<string>, content: string): number {
  if (queryTokens.size === 0) return 0;
  const memoryTokens = new Set(tokenize(content));
  if (memoryTokens.size === 0) return 0;
  let hits = 0;
  for (const token of memoryTokens) {
    if (queryTokens.has(token)) hits += 1;
  }
  return hits / Math.sqrt(memoryTokens.size);
}

function recencyScore(memory: Memory, now: number): number {
  const ts = memory.lastUsedAt ?? memory.createdAt;
  const ageDays = Math.max(0, (now - ts) / 86_400_000);
  return 1 / (1 + ageDays);
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
}

/** Plan C ranking: lexical overlap blended with importance and recency. */
export function rankByKeywords(memories: Memory[], query: string, now = Date.now()): ScoredMemory[] {
  const queryTokens = new Set(tokenize(query));
  return memories
    .map((memory) => ({
      memory,
      score: keywordScore(queryTokens, memory.content) * 0.7 + memory.importance * 0.2 + recencyScore(memory, now) * 0.1,
    }))
    .sort((a, b) => b.score - a.score || b.memory.importance - a.memory.importance);
}

/** Plan A ranking: cosine similarity blended with importance and recency. */
export function rankByVectors(
  memories: Memory[],
  queryVec: Float32Array,
  vectors: Map<string, Float32Array>,
  now = Date.now(),
): ScoredMemory[] {
  return memories
    .map((memory) => {
      const vec = vectors.get(memory.id);
      const similarity = vec ? cosineSimilarity(queryVec, vec) : 0;
      return {
        memory,
        score: similarity * 0.8 + memory.importance * 0.15 + recencyScore(memory, now) * 0.05,
      };
    })
    .sort((a, b) => b.score - a.score || b.memory.importance - a.memory.importance);
}

/** Take top-ranked memories until the character budget is reached (always ≥1). */
export function selectWithinBudget(ranked: ScoredMemory[], budget: number): Memory[] {
  const out: Memory[] = [];
  let used = 0;
  for (const { memory } of ranked) {
    const cost = memory.content.length + memory.kind.length + 8;
    if (out.length > 0 && used + cost > budget) break;
    out.push(memory);
    used += cost;
  }
  return out;
}

/** Load stored embeddings and compute any missing ones (bounded per turn). */
async function collectEmbeddings(memories: Memory[], embed: EmbedFn): Promise<Map<string, Float32Array>> {
  const vectors = new Map<string, Float32Array>();
  const missing: Memory[] = [];
  for (const memory of memories) {
    if (memory.hasEmbedding) {
      const stored = getMemoryEmbedding(memory.id);
      if (stored) {
        vectors.set(memory.id, stored);
        continue;
      }
    }
    missing.push(memory);
  }
  for (const memory of missing.slice(0, MAX_BACKFILL_PER_TURN)) {
    const vec = await embed(memory.content);
    setMemoryEmbedding(memory.id, vec);
    vectors.set(memory.id, vec);
  }
  return vectors;
}

/**
 * Retrieve the memories most relevant to `query`, within a character budget.
 * Uses vector search when embeddings are configured, and transparently degrades
 * to keyword ranking when they are not configured or any step fails.
 */
export async function retrieveMemories(
  userId: string,
  query: string,
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const budget = options.budget ?? MAX_MEMORY_PROMPT_CHARS;
  const now = options.now ?? Date.now();
  const memories = listMemories(userId);
  if (memories.length === 0) return { memories: [], mode: "keyword" };

  const trimmedQuery = query.trim();
  if (embeddingsEnabled() && trimmedQuery) {
    const embed = options.embed ?? ((text: string) => embedText(text));
    try {
      const queryVec = await embed(trimmedQuery);
      const vectors = await collectEmbeddings(memories, embed);
      return { memories: selectWithinBudget(rankByVectors(memories, queryVec, vectors, now), budget), mode: "vector" };
    } catch (err) {
      logger.warn(`memory: vector retrieval failed, falling back to keywords: ${String(err)}`);
    }
  }

  return { memories: selectWithinBudget(rankByKeywords(memories, query, now), budget), mode: "keyword" };
}
