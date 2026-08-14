import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiGetFetch, apiPostFetch } = vi.hoisted(() => ({
  apiGetFetch: vi.fn(),
  apiPostFetch: vi.fn(),
}));

vi.mock("./api.js", () => ({
  apiGetFetch,
  apiPostFetch,
}));

import {
  cancelLoginSession,
  getLoginSession,
  pollLoginSession,
  startLoginSession,
  submitVerifyCode,
  waitForVerifyCode,
} from "./login-qr.js";

const QR_JSON = JSON.stringify({ qrcode: "q-1", qrcode_img_content: "https://example.com/qr" });
const statusJson = (status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ status, ...extra });

beforeEach(() => {
  apiGetFetch.mockReset();
  apiPostFetch.mockReset();
  apiPostFetch.mockResolvedValue(QR_JSON);
});

describe("startLoginSession", () => {
  it("fetches a QR code and returns a wait-phase session", async () => {
    const s = await startLoginSession({ key: "k1" });
    expect(s.phase).toBe("wait");
    expect(s.qrcodeUrl).toBe("https://example.com/qr");
    expect(s.connected).toBe(false);
    expect(apiPostFetch).toHaveBeenCalledTimes(1);
    expect(getLoginSession("k1")?.key).toBe("k1");
  });

  it("reuses a fresh existing session without refetching", async () => {
    await startLoginSession({ key: "k2" });
    apiPostFetch.mockClear();
    const again = await startLoginSession({ key: "k2" });
    expect(again.qrcodeUrl).toBe("https://example.com/qr");
    expect(apiPostFetch).not.toHaveBeenCalled();
  });

  it("force-refetches a new QR", async () => {
    await startLoginSession({ key: "k3" });
    apiPostFetch.mockClear();
    const again = await startLoginSession({ key: "k3", force: true });
    expect(again.phase).toBe("wait");
    expect(apiPostFetch).toHaveBeenCalledTimes(1);
  });

  it("returns a failed session when the gateway fetch throws", async () => {
    apiPostFetch.mockRejectedValue(new Error("boom"));
    const s = await startLoginSession({ key: "k4" });
    expect(s.phase).toBe("failed");
  });
});

describe("pollLoginSession", () => {
  it("walks wait → need_verifycode → (code) → connected", async () => {
    await startLoginSession({ key: "k1" });

    apiGetFetch.mockResolvedValueOnce(statusJson("need_verifycode"));
    let s = (await pollLoginSession("k1"))!;
    expect(s.phase).toBe("need_verifycode");
    expect(s.verifyRequired).toBe(true);

    // Driver pauses; the code arrives from outside (Web form / CLI stdin).
    const waiter = waitForVerifyCode("k1");
    submitVerifyCode("k1", "1234");
    await expect(waiter).resolves.toBe("1234");

    apiGetFetch.mockResolvedValueOnce(
      statusJson("confirmed", {
        bot_token: "tok-1",
        ilink_bot_id: "bot-1",
        baseurl: "https://x.example",
        ilink_user_id: "wx-1",
      }),
    );
    s = (await pollLoginSession("k1"))!;
    expect(s.phase).toBe("connected");
    expect(s.connected).toBe(true);
    expect(s.accountId).toBe("bot-1");
    expect(s.botToken).toBe("tok-1");
    expect(s.wechatUserId).toBe("wx-1");
    expect(apiGetFetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: expect.stringContaining("verify_code=1234") }),
    );
  });

  it("keeps the pending code across intermediate polls", async () => {
    await startLoginSession({ key: "k2" });
    apiGetFetch.mockResolvedValueOnce(statusJson("need_verifycode"));
    await pollLoginSession("k2");
    submitVerifyCode("k2", "99");
    // Gateway still processing → wait; code must be retained for the next poll.
    apiGetFetch.mockResolvedValueOnce(statusJson("wait"));
    expect((await pollLoginSession("k2"))!.phase).toBe("wait");
    apiGetFetch.mockResolvedValueOnce(statusJson("confirmed", { ilink_bot_id: "bot-2" }));
    await pollLoginSession("k2");
    expect(apiGetFetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ endpoint: expect.stringContaining("verify_code=99") }),
    );
  });

  it("refreshes the QR on expiry and fails after the cap", async () => {
    await startLoginSession({ key: "k3" });
    apiGetFetch.mockResolvedValue(statusJson("expired"));
    // refreshCount 1..3 → refresh + wait; 4th → failed.
    expect((await pollLoginSession("k3"))!.phase).toBe("wait");
    expect((await pollLoginSession("k3"))!.phase).toBe("wait");
    expect((await pollLoginSession("k3"))!.phase).toBe("wait");
    const s = (await pollLoginSession("k3"))!;
    expect(s.phase).toBe("failed");
    expect(getLoginSession("k3")).toBeNull();
  });

  it("reports already_connected and clears the session on binded_redirect", async () => {
    await startLoginSession({ key: "k4" });
    apiGetFetch.mockResolvedValueOnce(statusJson("binded_redirect"));
    const s = (await pollLoginSession("k4"))!;
    expect(s.phase).toBe("already_connected");
    expect(getLoginSession("k4")).toBeNull();
  });

  it("fails on confirmed without an ilink_bot_id", async () => {
    await startLoginSession({ key: "k5" });
    apiGetFetch.mockResolvedValueOnce(statusJson("confirmed", { bot_token: "tok" }));
    const s = (await pollLoginSession("k5"))!;
    expect(s.phase).toBe("failed");
  });

  it("switches the polling host on IDC redirect", async () => {
    await startLoginSession({ key: "k6" });
    apiGetFetch.mockResolvedValueOnce(statusJson("scaned_but_redirect", { redirect_host: "host2.example" }));
    expect((await pollLoginSession("k6"))!.phase).toBe("scanned");
    apiGetFetch.mockResolvedValueOnce(statusJson("wait"));
    await pollLoginSession("k6");
    expect(apiGetFetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseUrl: "https://host2.example" }),
    );
  });

  it("returns null for unknown keys", async () => {
    expect(await pollLoginSession("nope")).toBeNull();
  });
});

describe("cancelLoginSession", () => {
  it("cancels the session and unblocks waiters", async () => {
    await startLoginSession({ key: "k7" });
    apiGetFetch.mockResolvedValueOnce(statusJson("need_verifycode"));
    await pollLoginSession("k7");
    const waiter = waitForVerifyCode("k7");
    cancelLoginSession("k7");
    await expect(waiter).resolves.toBe("");
    expect(getLoginSession("k7")).toBeNull();
  });
});
