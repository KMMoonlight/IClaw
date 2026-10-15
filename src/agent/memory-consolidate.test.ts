import { beforeEach, describe, expect, it } from "vitest";

import { addMemory, createUser, getMemory, listMemories, openDb, openDbInMemory } from "../db/index.js";
import type { AddMemoryOptions } from "../db/index.js";
import {
  CONSOLIDATE_DEFAULTS,
  consolidateAllUsers,
  consolidateMemories,
  jaccardSimilarity,
  normalizeContent,
} from "./memory-consolidate.js";

const DAY = 86_400_000;

beforeEach(() => {
  openDbInMemory();
});

/** Backdate a memory's created_at (and clear last_used_at) for decay tests. */
function backdate(id: string, ageDays: number): void {
  openDb()
    .prepare("UPDATE memories SET created_at = ?, last_used_at = NULL WHERE id = ?")
    .run(Date.now() - ageDays * DAY, id);
}

describe("normalizeContent / jaccardSimilarity", () => {
  it("strips case, whitespace and punctuation", () => {
    expect(normalizeContent(" Likes  Coffee！ ")).toBe("likescoffee");
    expect(normalizeContent("喜欢，咖啡。")).toBe("喜欢咖啡");
  });

  it("measures token overlap", () => {
    expect(jaccardSimilarity(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccardSimilarity(["a", "b"], ["c"])).toBe(0);
    expect(jaccardSimilarity([], ["a"])).toBe(0);
  });
});

describe("consolidateMemories — merging", () => {
  it("merges exact duplicates that differ only by case/whitespace/punctuation", () => {
    const u = createUser("u");
    addMemory(u.id, "喜欢 咖啡", { importance: 0.4 });
    addMemory(u.id, "喜欢，咖啡。", { importance: 0.6 });
    const result = consolidateMemories(u.id);
    expect(result.merged).toBe(1);
    expect(result.remaining).toBe(1);
    expect(listMemories(u.id)[0]!.importance).toBe(0.6);
  });

  it("merges near-duplicates and keeps the higher-importance one", () => {
    const u = createUser("u");
    addMemory(u.id, "用户喜欢喝美式咖啡", { importance: 0.3 });
    addMemory(u.id, "用户喜欢喝美式咖啡哦", { importance: 0.8 });
    const result = consolidateMemories(u.id);
    expect(result.merged).toBe(1);
    expect(listMemories(u.id)[0]!.importance).toBe(0.8);
  });

  it("keeps distinct memories", () => {
    const u = createUser("u");
    addMemory(u.id, "住在上海");
    addMemory(u.id, "喜欢喝咖啡");
    const result = consolidateMemories(u.id);
    expect(result.merged).toBe(0);
    expect(result.remaining).toBe(2);
  });
});

describe("consolidateMemories — decay", () => {
  function lowStale(u: string, content: string, opts: AddMemoryOptions = {}) {
    const m = addMemory(u, content, { importance: 0.1, ...opts });
    backdate(m.id, 200);
    return m;
  }

  it("prunes stale low-importance memories", () => {
    const u = createUser("u");
    const stale = lowStale(u.id, "很久没用的低重要事实");
    const result = consolidateMemories(u.id);
    expect(result.pruned).toBe(1);
    expect(getMemory(stale.id)).toBeNull();
  });

  it("keeps fresh low-importance memories", () => {
    const u = createUser("u");
    addMemory(u.id, "刚记下的低重要事实", { importance: 0.1 });
    expect(consolidateMemories(u.id).pruned).toBe(0);
    expect(listMemories(u.id)).toHaveLength(1);
  });

  it("keeps stale but important memories", () => {
    const u = createUser("u");
    const m = addMemory(u.id, "很久以前的重要事实", { importance: 0.9 });
    backdate(m.id, 365);
    expect(consolidateMemories(u.id).pruned).toBe(0);
    expect(getMemory(m.id)).not.toBeNull();
  });

  it("never prunes profile memories", () => {
    const u = createUser("u");
    const m = lowStale(u.id, "用户档案：低重要", { kind: "profile" });
    expect(consolidateMemories(u.id).pruned).toBe(0);
    expect(getMemory(m.id)).not.toBeNull();
  });
});

describe("consolidateMemories — cap", () => {
  it("drops the lowest-importance memories beyond the cap, never profile", () => {
    const u = createUser("u");
    addMemory(u.id, "档案", { kind: "profile", importance: 0.1 });
    addMemory(u.id, "低", { importance: 0.1 });
    addMemory(u.id, "中", { importance: 0.4 });
    addMemory(u.id, "高", { importance: 0.9 });
    const result = consolidateMemories(u.id, { maxPerUser: 3 });
    expect(result.pruned).toBe(1);
    const remaining = listMemories(u.id).map((m) => m.content).sort();
    expect(remaining).toEqual(["中", "档案", "高"]);
  });

  it("still enforces the cap when there are more profiles than the limit", () => {
    const u = createUser("u");
    for (let i = 0; i < 5; i++) addMemory(u.id, `档案${i}`, { kind: "profile", importance: 0.1 + i * 0.1 });
    const result = consolidateMemories(u.id, { maxPerUser: 3 });
    expect(result.pruned).toBe(2);
    expect(listMemories(u.id)).toHaveLength(3);
    // Lowest-importance profiles are the ones evicted.
    expect(listMemories(u.id).map((m) => m.content).sort()).toEqual(["档案2", "档案3", "档案4"]);
  });
});

describe("consolidateAllUsers", () => {
  it("runs per user and reports each result", () => {
    const a = createUser("a");
    const b = createUser("b");
    addMemory(a.id, "重复 事实");
    addMemory(a.id, "重复事实");
    addMemory(b.id, "唯一");
    const results = consolidateAllUsers();
    expect(results).toHaveLength(2);
    const forA = results.find((r) => r.userId === a.id)!;
    expect(forA.merged).toBe(1);
    expect(results.find((r) => r.userId === b.id)!.merged).toBe(0);
  });
});

describe("defaults", () => {
  it("ships sane thresholds", () => {
    expect(CONSOLIDATE_DEFAULTS.maxPerUser).toBeGreaterThan(0);
    expect(CONSOLIDATE_DEFAULTS.mergeSimilarity).toBeGreaterThan(0.5);
    expect(CONSOLIDATE_DEFAULTS.staleDays).toBeGreaterThan(0);
  });
});
