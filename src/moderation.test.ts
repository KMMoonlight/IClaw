import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "./config.js";
import { applyOutboundModeration, moderateOutbound } from "./moderation.js";

const KEYS = ["ICLAW_OUTBOUND_BLOCKLIST", "ICLAW_OUTBOUND_BLOCK_MESSAGE"] as const;
const saved = new Map<string, string | undefined>();
for (const k of KEYS) saved.set(k, process.env[k]);

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  for (const k of KEYS) setEnv(k, undefined);
  resetConfigCache();
});

afterEach(() => {
  for (const k of KEYS) setEnv(k, saved.get(k));
  resetConfigCache();
});

describe("moderateOutbound", () => {
  it("allows everything when no blocklist is configured", () => {
    expect(moderateOutbound("anything").ok).toBe(true);
  });

  it("blocks matching patterns case-insensitively", () => {
    setEnv("ICLAW_OUTBOUND_BLOCKLIST", "secret-code, 违禁词");
    resetConfigCache();
    expect(moderateOutbound("this leaks SECRET-CODE now").ok).toBe(false);
    expect(moderateOutbound("这里包含违禁词").ok).toBe(false);
    expect(moderateOutbound("正常内容").ok).toBe(true);
    expect(moderateOutbound("this leaks SECRET-CODE now").reason).toBe("secret-code");
  });

  it("ignores malformed patterns", () => {
    setEnv("ICLAW_OUTBOUND_BLOCKLIST", "(");
    resetConfigCache();
    expect(moderateOutbound("anything").ok).toBe(true);
  });
});

describe("applyOutboundModeration", () => {
  it("replaces blocked text with the default message", () => {
    setEnv("ICLAW_OUTBOUND_BLOCKLIST", "badword");
    resetConfigCache();
    expect(applyOutboundModeration("say badword")).toBe("抱歉，这条内容不适合发送。");
    expect(applyOutboundModeration("fine")).toBe("fine");
  });

  it("uses a custom replacement message", () => {
    setEnv("ICLAW_OUTBOUND_BLOCKLIST", "x");
    setEnv("ICLAW_OUTBOUND_BLOCK_MESSAGE", "[已拦截]");
    resetConfigCache();
    expect(applyOutboundModeration("xxx")).toBe("[已拦截]");
  });
});
