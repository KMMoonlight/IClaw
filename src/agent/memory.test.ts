import { beforeEach, describe, expect, it } from "vitest";

import { addMemory, createUser, listMemories, openDbInMemory } from "../db/index.js";
import type { Memory } from "../db/index.js";
import {
  buildMemorySection,
  formatMemories,
  rankMemories,
  selectMemoriesForPrompt,
} from "./memory.js";

beforeEach(() => {
  openDbInMemory();
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

describe("rankMemories", () => {
  it("ranks by importance then recency", () => {
    const ranked = rankMemories([mem("low", 0.1, 100), mem("high-old", 0.9, 1), mem("high-new", 0.9, 200)]);
    expect(ranked.map((m) => m.content)).toEqual(["high-new", "high-old", "low"]);
  });
});

describe("selectMemoriesForPrompt", () => {
  it("includes everything when under budget", () => {
    const all = [mem("a"), mem("b")];
    expect(selectMemoriesForPrompt(all, 1000)).toHaveLength(2);
  });

  it("always keeps at least one memory even if it exceeds the budget", () => {
    const selected = selectMemoriesForPrompt([mem("x".repeat(500))], 10);
    expect(selected).toHaveLength(1);
  });

  it("stops once the budget is reached", () => {
    const all = [mem("a", 0.9), mem("b", 0.8), mem("c", 0.7)];
    const selected = selectMemoriesForPrompt(all, 20);
    expect(selected.map((m) => m.content)).toEqual(["a"]);
  });
});

describe("buildMemorySection / formatMemories", () => {
  it("renders kind-tagged bullets", () => {
    expect(formatMemories([mem("喜欢茶", 0.5, 1, "preference")])).toBe("- [preference] 喜欢茶");
  });

  it("returns null when there is nothing to inject", () => {
    expect(buildMemorySection([])).toBeNull();
  });

  it("wraps the formatted list under the memory heading", () => {
    const section = buildMemorySection([mem("事实一")]);
    expect(section).toContain("## 关于当前用户的记忆");
    expect(section).toContain("- [fact] 事实一");
  });
});

describe("buildMemorySection from the database", () => {
  it("renders a user's stored memories", () => {
    const u = createUser("u");
    addMemory(u.id, "住在杭州", { kind: "profile", importance: 0.9 });
    const section = buildMemorySection(listMemories(u.id));
    expect(section).toContain("- [profile] 住在杭州");
  });

  it("returns null for a user with no memories", () => {
    const u = createUser("u");
    expect(buildMemorySection(listMemories(u.id))).toBeNull();
  });
});
