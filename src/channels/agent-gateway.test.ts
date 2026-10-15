import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAgentTurn, resetUserSession, dropAgent, runUserExclusive } = vi.hoisted(() => ({
  runAgentTurn: vi.fn(),
  resetUserSession: vi.fn(),
  dropAgent: vi.fn(),
  // Default: run the task inline (no real turn chain in unit tests).
  runUserExclusive: vi.fn((_userId: string, task: () => Promise<unknown>) => task()),
}));

vi.mock("../agent/runtime.js", () => ({ runAgentTurn, resetUserSession, dropAgent, runUserExclusive }));

import { clearAllPendingActions, setPendingAction } from "../agent/approvals.js";
import { resetQuotaState } from "../agent/quota.js";
import { createUser, openDbInMemory, setUserStatus } from "../db/index.js";
import { createAgentGateway } from "./agent-gateway.js";
import type { InboundMessage, ReplySink } from "./types.js";

function sink(): { texts: string[]; typing: number; reply: ReplySink } {
  const state = { texts: [] as string[], typing: 0 };
  return {
    get texts() {
      return state.texts;
    },
    get typing() {
      return state.typing;
    },
    reply: {
      text: async (t: string) => {
        state.texts.push(t);
      },
      startTyping: async () => {
        state.typing += 1;
      },
      stopTyping: async () => {
        state.typing += 1;
      },
    },
  };
}

const msg = (text: string): InboundMessage => ({ channelId: "test", accountId: "acc", senderId: "s", text });

beforeEach(() => {
  openDbInMemory();
  clearAllPendingActions();
  resetQuotaState();
  runAgentTurn.mockReset();
  resetUserSession.mockReset();
  dropAgent.mockReset();
  runUserExclusive.mockReset().mockImplementation((_userId: string, task: () => Promise<unknown>) => task());
});

describe("agent gateway", () => {
  it("routes to the resolved user, runs a turn and sends the reply", async () => {
    const user = createUser("u");
    runAgentTurn.mockResolvedValue("这是回复");
    const out = sink();
    const gateway = createAgentGateway({ resolveUserId: () => user.id });

    await gateway(msg("你好"), out.reply);

    expect(runAgentTurn).toHaveBeenCalledWith(user.id, expect.objectContaining({ body: "你好" }), expect.anything());
    expect(out.texts).toEqual(["这是回复"]);
    expect(out.typing).toBe(2);
  });

  it("calls onUnbound when no user is resolved", async () => {
    const out = sink();
    const onUnbound = vi.fn(async (_m: InboundMessage, reply: ReplySink) => reply.text("未绑定"));
    const gateway = createAgentGateway({ resolveUserId: () => null, onUnbound });

    await gateway(msg("hi"), out.reply);
    expect(onUnbound).toHaveBeenCalledTimes(1);
    expect(out.texts).toEqual(["未绑定"]);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("stays silent for a frozen user", async () => {
    const user = createUser("u");
    setUserStatus(user.id, "frozen");
    const out = sink();
    await createAgentGateway({ resolveUserId: () => user.id })(msg("hi"), out.reply);
    expect(out.texts).toEqual([]);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("handles /new without running a turn", async () => {
    const user = createUser("u");
    const out = sink();
    await createAgentGateway({ resolveUserId: () => user.id })(msg("/new"), out.reply);
    expect(resetUserSession).toHaveBeenCalledWith(user.id);
    expect(out.texts.join()).toContain("新会话");
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("executes a pending dangerous tool when the user approves", async () => {
    const user = createUser("u");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "命令输出" }], details: {} });
    setPendingAction(user.id, {
      userId: user.id,
      toolName: "bash",
      params: { command: "ls" },
      execute: execute as never,
      createdAt: Date.now(),
    });
    const out = sink();
    await createAgentGateway({ resolveUserId: () => user.id })(msg("同意"), out.reply);
    expect(execute).toHaveBeenCalledWith("approval", { command: "ls" });
    expect(out.texts.join()).toContain("命令输出");
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
