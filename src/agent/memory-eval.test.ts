import { beforeEach, describe, expect, it } from "vitest";

import { addMemory, createUser, listMemories, openDbInMemory } from "../db/index.js";
import { buildMemorySection } from "./memory.js";
import { persistExtractedMemories } from "./memory-extract.js";
import { retrieveMemories } from "./memory-retrieval.js";

beforeEach(() => {
  openDbInMemory();
});

/**
 * Behavioural regression set for the memory pipeline. These assert the user-
 * visible outcome ("did the right fact surface?") rather than internal calls.
 */
const FACTS: Array<{ content: string; kind: string }> = [
  { content: "用户喜欢喝美式咖啡", kind: "preference" },
  { content: "用户住在上海", kind: "profile" },
  { content: "用户是做软件开发的工程师", kind: "profile" },
  { content: "用户有一个女儿叫小雨", kind: "profile" },
  { content: "用户对花生过敏", kind: "fact" },
  { content: "用户的生日是 3 月 12 日", kind: "profile" },
];

const CASES: Array<{ query: string; expect: string }> = [
  { query: "推荐我喝点咖啡", expect: "用户喜欢喝美式咖啡" },
  { query: "我住在哪个城市？", expect: "用户住在上海" },
  { query: "我是软件工程师吗", expect: "用户是做软件开发的工程师" },
  { query: "我女儿叫什么", expect: "用户有一个女儿叫小雨" },
  { query: "我对什么过敏", expect: "用户对花生过敏" },
  { query: "我生日是哪天", expect: "用户的生日是 3 月 12 日" },
];

function seed(userId: string): void {
  for (const fact of FACTS) addMemory(userId, fact.content, { kind: fact.kind });
}

describe("memory eval — retrieval recall", () => {
  it("surfaces the right fact as the top hit for every scenario", async () => {
    const u = createUser("u");
    seed(u.id);

    let hits = 0;
    for (const { query, expect: expected } of CASES) {
      const { memories } = await retrieveMemories(u.id, query);
      if (memories[0]?.content === expected) hits += 1;
    }
    expect(hits).toBe(CASES.length);
  });

  it("keeps the surfaced fact within the injected prompt section", async () => {
    const u = createUser("u");
    seed(u.id);
    for (const { query, expect: expected } of CASES) {
      const { memories } = await retrieveMemories(u.id, query);
      const section = buildMemorySection(memories);
      expect(section, query).toContain(expected);
    }
  });

  it("uses the keyword path when embeddings are not configured", async () => {
    const u = createUser("u");
    seed(u.id);
    const { mode } = await retrieveMemories(u.id, "咖啡");
    expect(mode).toBe("keyword");
  });
});

describe("memory eval — no duplicate accumulation", () => {
  it("does not re-add a fact that is already remembered", () => {
    const u = createUser("u");
    seed(u.id);
    const before = listMemories(u.id).length;
    // Extraction proposes a fact already stored (case/punctuation differs).
    const added = persistExtractedMemories(u.id, [
      { content: "用户喜欢喝美式咖啡", kind: "preference", importance: 0.5 },
      { content: "用户养了一只猫", kind: "fact", importance: 0.5 },
    ]);
    expect(added).toBe(1);
    expect(listMemories(u.id)).toHaveLength(before + 1);
  });
});
