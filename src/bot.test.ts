import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAgentTurn, resetUserSession, sendTextMessage } = vi.hoisted(() => ({
  runAgentTurn: vi.fn(),
  resetUserSession: vi.fn(),
  sendTextMessage: vi.fn(),
}));

vi.mock("./agent/runtime.js", () => ({ runAgentTurn, resetUserSession }));
vi.mock("./wechat/send.js", () => ({ sendTextMessage }));
vi.mock("./wechat/typing.js", () => ({
  TypingSession: class {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
}));

import { createBotHandler } from "./bot.js";
import { bindBotAccount, createUser, openDbInMemory, setUserStatus } from "./db/index.js";
import type { InboundContext } from "./wechat/inbound.js";

beforeEach(() => {
  openDbInMemory();
  runAgentTurn.mockReset();
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

    expect(runAgentTurn).toHaveBeenCalledWith(user.id, expect.objectContaining({ accountId: "acc-1" }));
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
