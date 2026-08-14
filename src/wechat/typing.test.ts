import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConfig, sendTyping } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  sendTyping: vi.fn(),
}));

vi.mock("./api.js", () => ({ getConfig, sendTyping }));

import { resolveTypingTicket, sendTypingIndicator, TypingSession } from "./typing.js";
import { TypingStatus } from "./types.js";

beforeEach(() => {
  getConfig.mockReset();
  sendTyping.mockReset();
  sendTyping.mockResolvedValue(undefined);
});

describe("resolveTypingTicket", () => {
  it("fetches and caches the ticket (no refetch within TTL)", async () => {
    getConfig.mockResolvedValue({ ret: 0, typing_ticket: "ticket-1" });
    expect(await resolveTypingTicket({ baseUrl: "https://x", wechatUserId: "u1" })).toBe("ticket-1");
    getConfig.mockClear();
    expect(await resolveTypingTicket({ baseUrl: "https://x", wechatUserId: "u1" })).toBe("ticket-1");
    expect(getConfig).not.toHaveBeenCalled();
  });

  it("returns empty and backs off on failure, then retries later", async () => {
    getConfig.mockRejectedValue(new Error("network"));
    expect(await resolveTypingTicket({ baseUrl: "https://x", wechatUserId: "u2" })).toBe("");
    getConfig.mockClear();
    // Still within backoff window → no refetch, cached "" returned.
    expect(await resolveTypingTicket({ baseUrl: "https://x", wechatUserId: "u2" })).toBe("");
    expect(getConfig).not.toHaveBeenCalled();
  });

  it("returns an empty ticket when the gateway reports an error ret", async () => {
    getConfig.mockResolvedValue({ ret: -1, errmsg: "no ticket" });
    expect(await resolveTypingTicket({ baseUrl: "https://x", wechatUserId: "u3" })).toBe("");
  });
});

describe("TypingSession", () => {
  it("sends TYPING on start and CANCEL on stop", async () => {
    getConfig.mockResolvedValue({ ret: 0, typing_ticket: "t-1" });
    const session = new TypingSession({ baseUrl: "https://x", wechatUserId: "u4" });
    await session.start();
    await session.stop();

    expect(sendTyping).toHaveBeenCalledTimes(2);
    const statuses = sendTyping.mock.calls.map((c) => (c[0] as { body: { status: number } }).body.status);
    expect(statuses).toEqual([TypingStatus.TYPING, TypingStatus.CANCEL]);
  });

  it("does nothing when no ticket is available", async () => {
    getConfig.mockResolvedValue({ ret: 0, typing_ticket: "" });
    const session = new TypingSession({ baseUrl: "https://x", wechatUserId: "u5" });
    await session.start();
    await session.stop();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("keeps the TYPING indicator alive every 5s during the turn", async () => {
    vi.useFakeTimers();
    try {
      getConfig.mockResolvedValue({ ret: 0, typing_ticket: "t-1" });
      const session = new TypingSession({ baseUrl: "https://x", wechatUserId: "u6" });
      await session.start();
      expect(sendTyping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sendTyping).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sendTyping).toHaveBeenCalledTimes(3);
      await session.stop();
      const last = sendTyping.mock.calls.at(-1)?.[0] as { body: { status: number } };
      expect(last.body.status).toBe(TypingStatus.CANCEL);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sendTypingIndicator", () => {
  it("swallows gateway errors", async () => {
    sendTyping.mockRejectedValue(new Error("gateway down"));
    await expect(
      sendTypingIndicator({ baseUrl: "https://x", wechatUserId: "u7", typingTicket: "t", status: TypingStatus.TYPING }),
    ).resolves.toBeUndefined();
  });
});
