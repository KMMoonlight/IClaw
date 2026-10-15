import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAgentTurn, resetUserSession, dropAgent, runUserExclusive, sendTextMessage } = vi.hoisted(() => ({
  runAgentTurn: vi.fn(),
  resetUserSession: vi.fn(),
  dropAgent: vi.fn(),
  runUserExclusive: vi.fn((_userId: string, task: () => Promise<unknown>) => task()),
  sendTextMessage: vi.fn(),
}));

vi.mock("./agent/runtime.js", () => ({ runAgentTurn, resetUserSession, dropAgent, runUserExclusive }));
vi.mock("./wechat/send.js", () => ({ sendTextMessage, sendTextChunked: sendTextMessage }));
vi.mock("./wechat/typing.js", () => ({
  TypingSession: class {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
}));

import { createBotHandler } from "./bot.js";
import { clearAllPendingActions, getPendingAction, setPendingAction } from "./agent/approvals.js";
import { resetQuotaState } from "./agent/quota.js";
import { resetConfigCache } from "./config.js";
import { bindBotAccount, createSession, createUser, openDbInMemory, setUserStatus } from "./db/index.js";
import type { InboundContext } from "./wechat/inbound.js";

beforeEach(() => {
  openDbInMemory();
  clearAllPendingActions();
  resetQuotaState();
  runAgentTurn.mockReset();
  runUserExclusive.mockReset().mockImplementation((_userId: string, task: () => Promise<unknown>) => task());
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "m1" });
});

function ctx(accountId: string, body = "你好"): InboundContext {
  return { body, from: "wx-from@im.wechat", accountId, contextToken: "ct", timestamp: 1 };
}

describe("bot routing（扫码即绑定：accountId → user）", () => {
  it("routes a bound, active account to its user's agent and sends the reply", async () => {
    const user = createUser("张三");
    bindBotAccount("acc-1", user.id, "wx-from@im.wechat");
    runAgentTurn.mockResolvedValue("这是回复");

    await createBotHandler()(ctx("acc-1"));

    expect(runAgentTurn).toHaveBeenCalledWith(user.id, expect.objectContaining({ accountId: "acc-1" }), expect.anything());
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "这是回复" }));
  });

  it("stays silent for a frozen user", async () => {
    const user = createUser("张三");
    setUserStatus(user.id, "frozen");
    bindBotAccount("acc-1", user.id, "wx-from@im.wechat");

    await createBotHandler()(ctx("acc-1"));

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("replies with a hint for an unbound account", async () => {
    await createBotHandler()(ctx("acc-nobody"));

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("尚未绑定") }),
    );
  });

  it("sends a generic error reply when the agent turn fails", async () => {
    const user = createUser("张三");
    bindBotAccount("acc-1", user.id, "wx-from@im.wechat");
    runAgentTurn.mockRejectedValue(new Error("internal detail: api key"));

    await createBotHandler()(ctx("acc-1"));

    const sent = sendTextMessage.mock.calls[0]?.[0] as { text: string };
    expect(sent.text).toBe("处理出错，请稍后再试。");
    expect(sent.text).not.toContain("api key");
  });

  it("handles /new as a new-session command without running the agent", async () => {
    const user = createUser("张三");
    bindBotAccount("acc-1", user.id, "wx-from@im.wechat");

    await createBotHandler()(ctx("acc-1", "/new"));
    expect(resetUserSession).toHaveBeenCalledWith(user.id);
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("新会话") }),
    );

    await createBotHandler()(ctx("acc-1", "/新会话"));
    expect(resetUserSession).toHaveBeenCalledTimes(2);
  });
});

describe("dangerous-tool approval", () => {
  function seedPending(userId: string, execute: ReturnType<typeof vi.fn>) {
    setPendingAction(userId, {
      userId,
      toolName: "bash",
      params: { command: "echo hi" },
      execute: execute as never,
      createdAt: Date.now(),
    });
  }

  it("executes the stored action when the user approves", async () => {
    const user = createUser("张三");
    bindBotAccount("acc-1", user.id, "wx-from@im.wechat");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "命令输出" }], details: {} });
    seedPending(user.id, execute);

    await createBotHandler()(ctx("acc-1", "同意"));

    expect(execute).toHaveBeenCalledWith("approval", { command: "echo hi" });
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("命令输出") }));
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(getPendingAction(user.id)).toBeNull();
  });

  it("cancels when the user rejects", async () => {
    const user = createUser("张三");
    bindBotAccount("acc-1", user.id, "wx-from@im.wechat");
    const execute = vi.fn();
    seedPending(user.id, execute);

    await createBotHandler()(ctx("acc-1", "拒绝"));

    expect(execute).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("已取消") }));
    expect(getPendingAction(user.id)).toBeNull();
  });

  it("appends a confirmation prompt when a tool is left pending after a turn", async () => {
    const user = createUser("张三");
    bindBotAccount("acc-1", user.id, "wx-from@im.wechat");
    runAgentTurn.mockImplementation(async (uid: string) => {
      seedPending(uid, vi.fn());
      return "请确认";
    });

    await createBotHandler()(ctx("acc-1", "帮我删掉文件"));

    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(texts.join("\n")).toContain("请确认");
    expect(texts.join("\n")).toContain("需要你确认");
  });

  it("streams partial reply chunks without duplicating the final reply", async () => {
    const user = createUser("张三");
    bindBotAccount("acc-1", user.id, "wx-from@im.wechat");
    runAgentTurn.mockImplementation(async (_uid: string, _ctx: unknown, hooks?: { onTextDelta?: (d: string) => void }) => {
      hooks?.onTextDelta?.("你好，世界");
      return "你好，世界";
    });

    await createBotHandler()(ctx("acc-1"));

    const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
    expect(texts).toEqual(["你好，世界"]);
  });
});

describe("per-user quota", () => {
  it("blocks a user who exceeds the per-minute rate limit", async () => {
    process.env.ICLAW_USER_RATE_PER_MIN = "1";
    resetConfigCache();
    try {
      const user = createUser("张三");
      bindBotAccount("acc-1", user.id, "wx-from@im.wechat");
      runAgentTurn.mockResolvedValue("ok");

      await createBotHandler()(ctx("acc-1", "第一条"));
      await createBotHandler()(ctx("acc-1", "第二条"));

      expect(runAgentTurn).toHaveBeenCalledTimes(1);
      const texts = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text);
      expect(texts.some((t) => t.includes("过于频繁"))).toBe(true);
    } finally {
      delete process.env.ICLAW_USER_RATE_PER_MIN;
      resetConfigCache();
      resetQuotaState();
    }
  });
});

describe("multi-session commands", () => {
  it("lists sessions and switches by index", async () => {
    const user = createUser("张三");
    bindBotAccount("acc-1", user.id, "wx-from@im.wechat");
    createSession(user.id, "会话A");

    await createBotHandler()(ctx("acc-1", "/sessions"));
    const listText = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text).join("\n");
    expect(listText).toContain("会话列表");
    expect(listText).toContain("当前");
    expect(runAgentTurn).not.toHaveBeenCalled();

    await createBotHandler()(ctx("acc-1", "/switch 1"));
    expect(dropAgent).toHaveBeenCalled();
    const switchText = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text).join("\n");
    expect(switchText).toContain("已切换");
  });

  it("rejects an invalid switch index", async () => {
    const user = createUser("张三");
    bindBotAccount("acc-1", user.id, "wx-from@im.wechat");
    await createBotHandler()(ctx("acc-1", "/switch 9"));
    const text = sendTextMessage.mock.calls.map((c) => (c[0] as { text: string }).text).join("\n");
    expect(text).toContain("用法");
  });
});
