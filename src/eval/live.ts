import assert from "node:assert/strict";

import { runAgentTurn } from "../agent/runtime.js";
import { createUser, getUserUsageTotal, openDbInMemory } from "../db/index.js";
import type { EvalCase } from "./types.js";

/**
 * Live, end-to-end eval cases that call the configured model. They are only
 * returned when ICLAW_EVAL_LIVE=1 so CI stays deterministic and offline.
 */
export function liveEvalCases(): EvalCase[] {
  if (process.env.ICLAW_EVAL_LIVE !== "1") return [];
  return [
    {
      group: "live",
      name: "agent returns a non-empty reply",
      run: async () => {
        openDbInMemory();
        const u = createUser("eval");
        const reply = await runAgentTurn(u.id, { body: "用一句话回答：1+1 等于几？", from: "", accountId: "" });
        assert.ok(reply.trim().length > 0, "模型返回了空回复");
      },
    },
    {
      group: "live",
      name: "usage is recorded after a turn",
      run: async () => {
        openDbInMemory();
        const u = createUser("eval");
        await runAgentTurn(u.id, { body: "说一句你好。", from: "", accountId: "" });
        const usage = getUserUsageTotal(u.id);
        assert.ok(usage.input + usage.output > 0, "未记录 token 用量");
      },
    },
  ];
}
