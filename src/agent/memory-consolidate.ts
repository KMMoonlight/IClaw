import { deleteMemory, listMemories, listUsers } from "../db/index.js";
import type { Memory } from "../db/index.js";
import { logger } from "../logger.js";
import { tokenize } from "./memory-retrieval.js";

const DAY_MS = 86_400_000;

/** Defaults for a consolidation pass. */
export const CONSOLIDATE_DEFAULTS = {
  /** Merge memories whose token sets are at least this similar (Jaccard). */
  mergeSimilarity: 0.8,
  /** Prune un-used memories older than this (days) when below `lowImportance`. */
  staleDays: 90,
  /** Only memories strictly below this importance are eligible for stale pruning. */
  lowImportance: 0.3,
  /** Hard cap on memories per user; the lowest-retention ones are dropped. */
  maxPerUser: 200,
} as const;

export interface ConsolidateOptions {
  now?: number;
  mergeSimilarity?: number;
  staleDays?: number;
  lowImportance?: number;
  maxPerUser?: number;
}

export interface ConsolidateResult {
  userId: string;
  merged: number;
  pruned: number;
  remaining: number;
}

/** Normalise content for exact-duplicate detection. */
export function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, "")
    .trim();
}

/** Jaccard similarity of two token multisets (sets). */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function recencyTs(memory: Memory): number {
  return memory.lastUsedAt ?? memory.createdAt;
}

function isBetter(candidate: Memory, incumbent: Memory): boolean {
  if (candidate.importance !== incumbent.importance) return candidate.importance > incumbent.importance;
  return candidate.createdAt >= incumbent.createdAt;
}

/** Keep the higher-importance / newer of two near-duplicate memories. */
function mergeDuplicates(memories: Memory[], threshold: number): { kept: Memory[]; removed: string[] } {
  const kept: Memory[] = [];
  const keptTokens: string[][] = [];
  const keptNorm: string[] = [];
  const removed: string[] = [];

  for (const memory of memories) {
    const norm = normalizeContent(memory.content);
    const tokens = tokenize(memory.content);
    let dupIndex = keptNorm.indexOf(norm);
    if (dupIndex < 0) {
      for (let i = 0; i < kept.length; i++) {
        if (jaccardSimilarity(keptTokens[i]!, tokens) >= threshold) {
          dupIndex = i;
          break;
        }
      }
    }
    if (dupIndex < 0) {
      kept.push(memory);
      keptTokens.push(tokens);
      keptNorm.push(norm);
      continue;
    }
    const incumbent = kept[dupIndex]!;
    if (isBetter(memory, incumbent)) {
      removed.push(incumbent.id);
      kept[dupIndex] = memory;
      keptTokens[dupIndex] = tokens;
      keptNorm[dupIndex] = norm;
    } else {
      removed.push(memory.id);
    }
  }
  return { kept, removed };
}

/**
 * One consolidation pass for a user:
 *  1. merge exact/near-duplicate memories (keep the better one),
 *  2. prune stale, low-importance memories (never `profile`),
 *  3. enforce the per-user cap by dropping the lowest-retention memories.
 * Deterministic and model-free (safe to run on a schedule).
 */
export function consolidateMemories(userId: string, options: ConsolidateOptions = {}): ConsolidateResult {
  const now = options.now ?? Date.now();
  const mergeSimilarity = options.mergeSimilarity ?? CONSOLIDATE_DEFAULTS.mergeSimilarity;
  const staleDays = options.staleDays ?? CONSOLIDATE_DEFAULTS.staleDays;
  const lowImportance = options.lowImportance ?? CONSOLIDATE_DEFAULTS.lowImportance;
  const maxPerUser = options.maxPerUser ?? CONSOLIDATE_DEFAULTS.maxPerUser;

  let merged = 0;
  let pruned = 0;

  // 1. merge duplicates
  const { kept, removed } = mergeDuplicates(listMemories(userId), mergeSimilarity);
  for (const id of removed) {
    deleteMemory(id);
    merged += 1;
  }

  // 2. prune stale low-importance memories
  const survivors: Memory[] = [];
  for (const memory of kept) {
    const ageDays = (now - recencyTs(memory)) / DAY_MS;
    if (memory.kind !== "profile" && memory.importance < lowImportance && ageDays > staleDays) {
      deleteMemory(memory.id);
      pruned += 1;
    } else {
      survivors.push(memory);
    }
  }

  // 3. enforce the cap as a hard limit. Non-profile memories are dropped first;
  //    profile memories are only evicted once nothing else is left, so the cap
  //    always holds instead of silently growing unbounded.
  if (survivors.length > maxPerUser) {
    const byRetention = (a: Memory, b: Memory): number => a.importance - b.importance || recencyTs(a) - recencyTs(b);
    const droppable = [
      ...survivors.filter((m) => m.kind !== "profile").sort(byRetention),
      ...survivors.filter((m) => m.kind === "profile").sort(byRetention),
    ];
    const excess = survivors.length - maxPerUser;
    for (let i = 0; i < excess; i++) {
      deleteMemory(droppable[i]!.id);
      pruned += 1;
    }
  }

  const remaining = listMemories(userId).length;
  return { userId, merged, pruned, remaining };
}

/** Consolidate every user; used at startup and by future scheduled jobs. */
export function consolidateAllUsers(options: ConsolidateOptions = {}): ConsolidateResult[] {
  const results: ConsolidateResult[] = [];
  for (const user of listUsers()) {
    try {
      const result = consolidateMemories(user.id, options);
      if (result.merged > 0 || result.pruned > 0) {
        logger.info(`memory: consolidated user=${user.id} merged=${result.merged} pruned=${result.pruned}`);
      }
      results.push(result);
    } catch (err) {
      logger.warn(`memory: consolidation failed for user=${user.id}: ${String(err)}`);
    }
  }
  return results;
}
