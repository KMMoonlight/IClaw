import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { resetConfigCache } from "../config.js";
import { addMemory, createUser, listMemories, openDbInMemory } from "../db/index.js";
import {
  MAX_EXTRACTED_PER_TURN,
  buildExtractionPrompt,
  dedupeExtracted,
  extractAndRememberMemories,
  extractMemoriesFromConversation,
  parseExtractedMemories,
  persistExtractedMemories,
  serializeMessages,
} from "./memory-extract.js";

const origExtract = process.env.ICLAW_MEMORY_AUTO_EXTRACT;

beforeEach(() => {
  openDbInMemory();
  delete process.env.ICLAW_MEMORY_AUTO_EXTRACT;
  resetConfigCache();
});

afterEach(() => {
  if (origExtract === undefined) delete process.env.ICLAW_MEMORY_AUTO_EXTRACT;
  else process.env.ICLAW_MEMORY_AUTO_EXTRACT = origExtract;
  resetConfigCache();
});

function msg(role: "user" | "assistant", text: string): AgentMessage {
  return { role, content: [{ type: "text", text }], timestamp: Date.now() } as unknown as AgentMessage;
}

describe("serializeMessages", () => {
  it("renders role-tagged lines and skips empty content", () => {
    const text = serializeMessages([msg("user", "我叫张三"), { role: "assistant", content: [] } as unknown as AgentMessage, msg("assistant", "你好")]);
    expect(text).toBe("用户：我叫张三\n助手：你好");
  });
});

describe("parseExtractedMemories", () => {
  it("parses a plain JSON array and clamps/normalises fields", () => {
    const out = parseExtractedMemories(
      '[{"content":"喜欢美式","kind":"preference","importance":0.8},{"content":"住上海","kind":"bogus","importance":5}]',
    );
    expect(out).toEqual([
      { content: "喜欢美式", kind: "preference", importance: 0.8 },
      { content: "住上海", kind: "fact", importance: 1 },
    ]);
  });

  it("tolerates code fences and surrounding prose", () => {
    const out = parseExtractedMemories('好的，结果如下：\n```json\n[{"content":"x"}]\n```\n');
    expect(out).toEqual([{ content: "x", kind: "fact", importance: 0.5 }]);
  });

  it("accepts a plain string array and the `fact` alias", () => {
    expect(parseExtractedMemories('["a", "b"]')).toEqual([
      { content: "a", kind: "fact", importance: 0.5 },
      { content: "b", kind: "fact", importance: 0.5 },
    ]);
    expect(parseExtractedMemories('[{"fact":"别名"}]')[0]!.content).toBe("别名");
  });

  it("returns [] for malformed or empty output", () => {
    expect(parseExtractedMemories("not json")).toEqual([]);
    expect(parseExtractedMemories("[]")).toEqual([]);
    expect(parseExtractedMemories("[{bad json}]")).toEqual([]);
  });

  it("caps the number of extracted items", () => {
    const many = Array.from({ length: 50 }, (_, i) => `{"content":"fact-${i}"}`).join(",");
    expect(parseExtractedMemories(`[${many}]`)).toHaveLength(MAX_EXTRACTED_PER_TURN);
  });
});

describe("dedupeExtracted", () => {
  it("drops items already known or duplicated, case-insensitively", () => {
    const items = [
      { content: "Likes Tea", kind: "fact", importance: 0.5 },
      { content: "likes tea", kind: "fact", importance: 0.5 },
      { content: "new", kind: "fact", importance: 0.5 },
    ];
    expect(dedupeExtracted(items, ["LIKES TEA"]).map((i) => i.content)).toEqual(["new"]);
  });
});

describe("extractMemoriesFromConversation", () => {
  it("builds the prompt and returns deduped candidates", async () => {
    let seenSystem = "";
    let seenPrompt = "";
    const complete = async (systemPrompt: string, userPrompt: string) => {
      seenSystem = systemPrompt;
      seenPrompt = userPrompt;
      return '[{"content":"喜欢美式"},{"content":"已在记忆里"}]';
    };
    const out = await extractMemoriesFromConversation(
      [msg("user", "我每天都喝美式")],
      ["已在记忆里"],
      complete,
    );
    expect(out.map((i) => i.content)).toEqual(["喜欢美式"]);
    expect(seenSystem).toContain("记忆抽取器");
    expect(seenPrompt).toContain("<already-known>");
    expect(seenPrompt).toContain("我每天都喝美式");
  });

  it("short-circuits on an empty transcript", async () => {
    let called = false;
    const out = await extractMemoriesFromConversation([], [], async () => {
      called = true;
      return "[]";
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("persistExtractedMemories", () => {
  it("stores new memories tagged as auto and skips duplicates", () => {
    const u = createUser("u");
    addMemory(u.id, "已有事实");
    const added = persistExtractedMemories(u.id, [
      { content: "已有事实", kind: "fact", importance: 0.5 },
      { content: "新事实", kind: "event", importance: 0.6 },
    ]);
    expect(added).toBe(1);
    const memories = listMemories(u.id);
    expect(memories.map((m) => m.content)).toEqual(["已有事实", "新事实"]);
    expect(memories[1]!.source).toBe("auto");
    expect(memories[1]!.kind).toBe("event");
  });
});

describe("extractAndRememberMemories", () => {
  it("is a no-op when auto-extraction is disabled", async () => {
    const u = createUser("u");
    expect(await extractAndRememberMemories(u.id, [msg("user", "你好")])).toBe(0);
    expect(listMemories(u.id)).toEqual([]);
  });
});
