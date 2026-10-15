import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendTextMessage, resolveWeixinAccount, getContextToken, runScheduledAgentTurn } = vi.hoisted(() => ({
  sendTextMessage: vi.fn(),
  resolveWeixinAccount: vi.fn(),
  getContextToken: vi.fn(),
  runScheduledAgentTurn: vi.fn(),
}));

vi.mock("../wechat/send.js", () => ({ sendTextMessage }));
vi.mock("../wechat/accounts.js", () => ({ resolveWeixinAccount }));
vi.mock("../wechat/context-token.js", () => ({ getContextToken }));
vi.mock("../agent/runtime.js", () => ({ runScheduledAgentTurn }));

import { bindBotAccount, createUser, openDbInMemory } from "../db/index.js";
import { deliverTaskMessage, runScheduledTask } from "./deliver.js";
import { parseTaskPayload } from "./tasks.js";
import type { ScheduledTask } from "./tasks.js";

beforeEach(() => {
  openDbInMemory();
  sendTextMessage.mockReset().mockResolvedValue({ messageId: "m1" });
  runScheduledAgentTurn.mockReset().mockResolvedValue("agent 生成的内容");
  resolveWeixinAccount.mockReset().mockReturnValue({
    configured: true,
    baseUrl: "https://gw.example",
    token: "tok",
  });
  getContextToken.mockReset().mockReturnValue("ctx-token");
});

function task(userId: string, payload: string | null = null): ScheduledTask {
  return {
    id: "t1",
    userId,
    kind: "once",
    spec: "+1m",
    prompt: "该喝水了",
    payload,
    nextRunAt: Date.now(),
    lastRunAt: null,
    status: "active",
    createdAt: Date.now(),
  };
}

describe("deliverTaskMessage", () => {
  it("sends the task prompt to the user's bound bot", async () => {
    const u = createUser("u");
    bindBotAccount("acc-1", u.id, "wx-user-1");
    expect(await deliverTaskMessage(task(u.id))).toBe(true);
    expect(resolveWeixinAccount).toHaveBeenCalledWith("acc-1");
    expect(getContextToken).toHaveBeenCalledWith("acc-1", "wx-user-1");
    expect(sendTextMessage).toHaveBeenCalledWith({
      to: "wx-user-1",
      text: "该喝水了",
      opts: { baseUrl: "https://gw.example", token: "tok", contextToken: "ctx-token" },
    });
  });

  it("returns false without sending when the user has no binding", async () => {
    const u = createUser("u");
    expect(await deliverTaskMessage(task(u.id))).toBe(false);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("returns false when the bot account is not configured", async () => {
    const u = createUser("u");
    bindBotAccount("acc-1", u.id, "wx-user-1");
    resolveWeixinAccount.mockReturnValue({ configured: false });
    expect(await deliverTaskMessage(task(u.id))).toBe(false);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("propagates send failures so the scheduler can report them", async () => {
    const u = createUser("u");
    bindBotAccount("acc-1", u.id, "wx-user-1");
    sendTextMessage.mockRejectedValue(new Error("network down"));
    await expect(deliverTaskMessage(task(u.id))).rejects.toThrow("network down");
  });
});

describe("runScheduledTask", () => {
  it("sends the prompt verbatim in message mode (default)", async () => {
    const u = createUser("u");
    bindBotAccount("acc-1", u.id, "wx-user-1");
    expect(await runScheduledTask(task(u.id))).toBe(true);
    expect(runScheduledAgentTurn).not.toHaveBeenCalled();
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "该喝水了" }));
  });

  it("runs an agent turn and sends its reply in agent mode", async () => {
    const u = createUser("u");
    bindBotAccount("acc-1", u.id, "wx-user-1");
    expect(await runScheduledTask(task(u.id, '{"mode":"agent"}'))).toBe(true);
    expect(runScheduledAgentTurn).toHaveBeenCalledWith(u.id, "该喝水了");
    expect(sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "agent 生成的内容" }));
  });

  it("does not send when the agent turn produces no reply", async () => {
    const u = createUser("u");
    bindBotAccount("acc-1", u.id, "wx-user-1");
    runScheduledAgentTurn.mockResolvedValue("   ");
    expect(await runScheduledTask(task(u.id, '{"mode":"agent"}'))).toBe(false);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("falls back to message mode for malformed payloads", () => {
    expect(parseTaskPayload("not json").mode).toBe("message");
    expect(parseTaskPayload('{"mode":"agent"}').mode).toBe("agent");
    expect(parseTaskPayload(null).mode).toBe("message");
  });
});
