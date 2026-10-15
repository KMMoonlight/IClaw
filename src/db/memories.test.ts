import { beforeEach, describe, expect, it } from "vitest";

import {
  addMemory,
  clearUserMemories,
  countUserMemories,
  createUser,
  deleteMemory,
  findMemoryByContent,
  getMemory,
  getMemoryEmbedding,
  getMeta,
  listMemories,
  migrateLegacyMemory,
  openDbInMemory,
  setMemoryEmbedding,
  setMeta,
  setUserMemory,
  splitLegacyMemory,
  touchMemories,
  updateMemory,
} from "./index.js";

const LEGACY_FLAG = "legacy_memory_migrated_v1";

beforeEach(() => {
  openDbInMemory();
});

describe("memory CRUD", () => {
  it("adds and lists memories oldest-first with defaults", () => {
    const u = createUser("u");
    const a = addMemory(u.id, "喜欢喝美式");
    const b = addMemory(u.id, "住在上海", { kind: "profile", importance: 0.9 });
    expect(a.kind).toBe("fact");
    expect(a.source).toBe("user");
    expect(a.importance).toBe(0.5);
    expect(a.hasEmbedding).toBe(false);
    const list = listMemories(u.id);
    expect(list.map((m) => m.content)).toEqual(["喜欢喝美式", "住在上海"]);
    expect(list[1]!.kind).toBe("profile");
    expect(list[1]!.importance).toBe(0.9);
    expect(b.lastUsedAt).toBeNull();
  });

  it("isolates memories per user", () => {
    const a = createUser("a");
    const b = createUser("b");
    addMemory(a.id, "a-fact");
    addMemory(b.id, "b-fact");
    expect(listMemories(a.id).map((m) => m.content)).toEqual(["a-fact"]);
    expect(listMemories(b.id).map((m) => m.content)).toEqual(["b-fact"]);
  });

  it("finds memory by content case-insensitively", () => {
    const u = createUser("u");
    const m = addMemory(u.id, "Likes Coffee");
    expect(findMemoryByContent(u.id, "likes coffee")?.id).toBe(m.id);
    expect(findMemoryByContent(u.id, "nope")).toBeNull();
  });

  it("gets, updates and deletes a memory", () => {
    const u = createUser("u");
    const m = addMemory(u.id, "old");
    expect(getMemory(m.id)?.content).toBe("old");
    const updated = updateMemory(m.id, { content: "new", kind: "preference", importance: 1 });
    expect(updated?.content).toBe("new");
    expect(updated?.kind).toBe("preference");
    expect(updated?.importance).toBe(1);
    expect(updateMemory("missing", { content: "x" })).toBeNull();
    expect(deleteMemory(m.id)).toBe(true);
    expect(deleteMemory(m.id)).toBe(false);
    expect(getMemory(m.id)).toBeNull();
  });

  it("clears all memories for a user and counts them", () => {
    const u = createUser("u");
    addMemory(u.id, "one");
    addMemory(u.id, "two");
    expect(countUserMemories(u.id)).toBe(2);
    expect(clearUserMemories(u.id)).toBe(2);
    expect(countUserMemories(u.id)).toBe(0);
    expect(listMemories(u.id)).toEqual([]);
  });

  it("stores and clears embedding vectors", () => {
    const u = createUser("u");
    const m = addMemory(u.id, "vectorized");
    expect(getMemoryEmbedding(m.id)).toBeNull();
    const vec = new Float32Array([0.25, -1.5, 3]);
    setMemoryEmbedding(m.id, vec);
    const got = getMemoryEmbedding(m.id)!;
    expect(Array.from(got)).toEqual([0.25, -1.5, 3]);
    expect(getMemory(m.id)?.hasEmbedding).toBe(true);
    setMemoryEmbedding(m.id, null);
    expect(getMemoryEmbedding(m.id)).toBeNull();
    expect(getMemory(m.id)?.hasEmbedding).toBe(false);
  });

  it("passes an embedding at insert time", () => {
    const u = createUser("u");
    const m = addMemory(u.id, "with vector", { embedding: new Float32Array([1, 2]) });
    expect(m.hasEmbedding).toBe(true);
    expect(Array.from(getMemoryEmbedding(m.id)!)).toEqual([1, 2]);
  });

  it("touches last_used_at in bulk", () => {
    const u = createUser("u");
    const a = addMemory(u.id, "a");
    const b = addMemory(u.id, "b");
    touchMemories([]);
    expect(getMemory(a.id)?.lastUsedAt).toBeNull();
    touchMemories([a.id, b.id]);
    expect(getMemory(a.id)?.lastUsedAt).toBeGreaterThan(0);
    expect(getMemory(b.id)?.lastUsedAt).toBeGreaterThan(0);
  });
});

describe("legacy memory migration", () => {
  it("splits the legacy `- fact` format", () => {
    expect(splitLegacyMemory("- fact 1\n- fact 2")).toEqual(["fact 1", "fact 2"]);
    expect(splitLegacyMemory("just a blob")).toEqual(["just a blob"]);
    expect(splitLegacyMemory("")).toEqual([]);
    expect(splitLegacyMemory("  \n  ")).toEqual([]);
  });

  it("folds users.memory into memories exactly once", () => {
    const u = createUser("u");
    setUserMemory(u.id, "- likes tea\n- lives in Beijing");
    // Simulate a pre-migration database: clear the guard flag.
    setMeta(LEGACY_FLAG, "");
    migrateLegacyMemory();
    expect(listMemories(u.id).map((m) => m.content)).toEqual(["likes tea", "lives in Beijing"]);
    expect(getMeta(LEGACY_FLAG)).toBe("2");
    // Re-running must not duplicate.
    migrateLegacyMemory();
    expect(countUserMemories(u.id)).toBe(2);
    // Legacy source is tagged for provenance.
    expect(listMemories(u.id)[0]!.source).toBe("legacy");
  });

  it("is a no-op when the flag is already set", () => {
    const u = createUser("u");
    setUserMemory(u.id, "- should not migrate");
    // openDbInMemory already set the flag (value "0").
    expect(getMeta(LEGACY_FLAG)).toBe("0");
    migrateLegacyMemory();
    expect(countUserMemories(u.id)).toBe(0);
  });
});
