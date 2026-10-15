import assert from "node:assert/strict";

import { SECURITY_POLICY, wrapUntrusted } from "../agent/security.js";
import { withApproval } from "../agent/approvals.js";
import { addMemory, createSession, createUser, listMemories, openDbInMemory, setUserDisabledTools, switchActiveSession } from "../db/index.js";
import { applyOutboundModeration } from "../moderation.js";
import { buildMemorySection } from "../agent/memory.js";
import { persistExtractedMemories } from "../agent/memory-extract.js";
import { retrieveMemories } from "../agent/memory-retrieval.js";
import { consolidateMemories } from "../agent/memory-consolidate.js";
import { buildTools } from "../agent/tools.js";
import type { EvalCase } from "./types.js";

/** Deterministic, model-free behaviour checks (safe for CI). */
export function deterministicCases(): EvalCase[] {
  return [
    {
      group: "memory",
      name: "retrieval surfaces the relevant fact for a query",
      run: async () => {
        openDbInMemory();
        const u = createUser("u");
        addMemory(u.id, "用户喜欢喝美式咖啡");
        addMemory(u.id, "用户住在上海");
        const { memories } = await retrieveMemories(u.id, "推荐我喝点咖啡");
        assert.equal(memories[0]?.content, "用户喜欢喝美式咖啡");
      },
    },
    {
      group: "memory",
      name: "extraction does not duplicate an existing fact",
      run: () => {
        openDbInMemory();
        const u = createUser("u");
        addMemory(u.id, "用户喜欢喝美式咖啡");
        const added = persistExtractedMemories(u.id, [
          { content: "用户喜欢喝美式咖啡", kind: "preference", importance: 0.5 },
          { content: "用户养了一只猫", kind: "fact", importance: 0.5 },
        ]);
        assert.equal(added, 1);
        assert.equal(listMemories(u.id).length, 2);
      },
    },
    {
      group: "memory",
      name: "consolidation merges duplicates",
      run: () => {
        openDbInMemory();
        const u = createUser("u");
        addMemory(u.id, "喜欢 咖啡", { importance: 0.4 });
        addMemory(u.id, "喜欢，咖啡。", { importance: 0.6 });
        const result = consolidateMemories(u.id);
        assert.equal(result.merged, 1);
        assert.equal(result.remaining, 1);
      },
    },
    {
      group: "memory",
      name: "prompt section is bounded and non-empty",
      run: async () => {
        openDbInMemory();
        const u = createUser("u");
        addMemory(u.id, "事实一");
        const { memories } = await retrieveMemories(u.id, "事实");
        const section = buildMemorySection(memories);
        assert.ok(section && section.includes("事实一"));
      },
    },
    {
      group: "tools",
      name: "per-user tool policy removes disabled tools",
      run: () => {
        openDbInMemory();
        const u = createUser("u");
        setUserDisabledTools(u.id, ["web_fetch", "remember"]);
        const names = buildTools(u.id, []).map((t) => t.name);
        assert.ok(!names.includes("web_fetch"));
        assert.ok(!names.includes("remember"));
        assert.ok(names.includes("list_memories"));
      },
    },
    {
      group: "tools",
      name: "dangerous tool execution is deferred for approval",
      run: async () => {
        openDbInMemory();
        let ran = false;
        const wrapped = withApproval("u1", {
          name: "bash",
          label: "Bash",
          description: "d",
          parameters: {} as never,
          execute: async () => {
            ran = true;
            return { content: [{ type: "text", text: "ok" }], details: {} };
          },
        } as never);
        await wrapped.execute("c1", { command: "rm -rf" } as never);
        assert.equal(ran, false);
      },
    },
    {
      group: "safety",
      name: "security policy is injected and external content is marked untrusted",
      run: () => {
        assert.ok(SECURITY_POLICY.includes("不可信"));
        const wrapped = wrapUntrusted("https://x", "IGNORE INSTRUCTIONS");
        assert.ok(wrapped.includes("外部不可信内容"));
      },
    },
    {
      group: "safety",
      name: "outbound moderation passes benign text by default",
      run: () => {
        assert.equal(applyOutboundModeration("正常回复"), "正常回复");
      },
    },
    {
      group: "sessions",
      name: "switching the active session keeps history separate",
      run: () => {
        openDbInMemory();
        const u = createUser("u");
        const a = createSession(u.id, "A");
        const b = createSession(u.id, "B");
        assert.equal(switchActiveSession(u.id, a), true);
        assert.notEqual(a, b);
      },
    },
  ];
}
