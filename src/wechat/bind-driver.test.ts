import { beforeEach, describe, expect, it, vi } from "vitest";

const { startLoginSession, pollLoginSession, waitForVerifyCode, cancelLoginSession, getLoginSession } = vi.hoisted(() => ({
  startLoginSession: vi.fn(),
  pollLoginSession: vi.fn(),
  waitForVerifyCode: vi.fn(),
  cancelLoginSession: vi.fn(),
  getLoginSession: vi.fn(),
}));

vi.mock("./login-qr.js", () => ({
  startLoginSession,
  pollLoginSession,
  waitForVerifyCode,
  cancelLoginSession,
  getLoginSession,
}));

import { runBindSession, stopBindDriver } from "./bind-driver.js";
import type { LoginSession } from "./login-qr.js";

beforeEach(() => {
  startLoginSession.mockReset();
  pollLoginSession.mockReset();
  waitForVerifyCode.mockReset();
  cancelLoginSession.mockReset();
  getLoginSession.mockReset();
});

function session(phase: LoginSession["phase"], extra: Partial<LoginSession> = {}): LoginSession {
  return {
    key: "k",
    id: "s1",
    phase,
    message: phase,
    verifyRequired: phase === "need_verifycode",
    connected: phase === "connected",
    startedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...extra,
  };
}

describe("runBindSession", () => {
  it("drives wait → need_verifycode → connected and invokes onConnected", async () => {
    startLoginSession.mockResolvedValue(session("wait", { qrcodeUrl: "https://q" }));
    pollLoginSession
      .mockResolvedValueOnce(session("need_verifycode"))
      .mockResolvedValueOnce(session("connected", { accountId: "bot-1", botToken: "tok" }));
    waitForVerifyCode.mockResolvedValue("42");
    cancelLoginSession.mockImplementation(() => {});

    const phases: string[] = [];
    const onConnected = vi.fn();
    const result = await runBindSession({
      key: "k",
      pollIntervalMs: 1,
      onStateChange: (s) => phases.push(s.phase),
      onConnected,
    });

    expect(result.phase).toBe("connected");
    expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ accountId: "bot-1" }));
    expect(phases).toContain("need_verifycode");
    expect(waitForVerifyCode).toHaveBeenCalledWith("k");
  });

  it("stops on already_connected without invoking onConnected", async () => {
    startLoginSession.mockResolvedValue(session("wait"));
    pollLoginSession.mockResolvedValueOnce(session("already_connected"));
    const onConnected = vi.fn();
    const result = await runBindSession({ key: "k", pollIntervalMs: 1, onConnected });
    expect(result.phase).toBe("already_connected");
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("cancels when the signal aborts while polling", async () => {
    startLoginSession.mockResolvedValue(session("wait"));
    pollLoginSession.mockImplementation(async () => session("wait"));
    getLoginSession.mockReturnValue(session("wait"));
    cancelLoginSession.mockImplementation(() => {});
    const controller = new AbortController();
    const promise = runBindSession({ key: "k", pollIntervalMs: 1, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const result = await promise;
    expect(result.phase).toBe("cancelled");
    expect(cancelLoginSession).toHaveBeenCalledWith("k");
  });

  it("a stale driver steps aside when its session was replaced (does NOT cancel the new one)", async () => {
    // Old driver (session s1) polls and sees the map now holds a newer session (s2).
    startLoginSession.mockResolvedValue(session("wait", { id: "s1" }));
    pollLoginSession.mockResolvedValueOnce(session("wait", { id: "s2" }));
    cancelLoginSession.mockImplementation(() => {});

    const result = await runBindSession({ key: "k", pollIntervalMs: 1 });

    expect(result.phase).toBe("cancelled");
    expect(result.message).toContain("取代");
    expect(cancelLoginSession).not.toHaveBeenCalled();
  });

  it("an aborted stale driver does not cancel the replacement session", async () => {
    startLoginSession.mockResolvedValue(session("wait", { id: "s1" }));
    pollLoginSession.mockImplementation(async () => session("wait", { id: "s2" }));
    // The key now holds the replacement session.
    getLoginSession.mockReturnValue(session("wait", { id: "s2" }));
    cancelLoginSession.mockImplementation(() => {});

    const promise = runBindSession({ key: "k", pollIntervalMs: 1 });
    stopBindDriver("k");
    const result = await promise;

    expect(result.phase).toBe("cancelled");
    expect(cancelLoginSession).not.toHaveBeenCalled();
  });
});
