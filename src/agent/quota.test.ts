import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../config.js";
import { createUser, localDay, openDbInMemory, recordUsage } from "../db/index.js";
import { checkQuota, noteInboundMessage, resetQuotaState } from "./quota.js";

const KEYS = ["ICLAW_USER_RATE_PER_MIN", "ICLAW_USER_DAILY_TOKEN_LIMIT"] as const;
const saved = new Map<string, string | undefined>();
for (const k of KEYS) saved.set(k, process.env[k]);

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  openDbInMemory();
  resetQuotaState();
  for (const k of KEYS) setEnv(k, undefined);
  resetConfigCache();
});

afterEach(() => {
  for (const k of KEYS) setEnv(k, saved.get(k));
  resetConfigCache();
  resetQuotaState();
});

describe("checkQuota", () => {
  it("is unlimited by default", () => {
    const u = createUser("u");
    for (let i = 0; i < 100; i++) noteInboundMessage(u.id, 1000);
    expect(checkQuota(u.id, 1000).allowed).toBe(true);
  });

  it("enforces a per-minute message rate", () => {
    setEnv("ICLAW_USER_RATE_PER_MIN", "3");
    resetConfigCache();
    const u = createUser("u");
    noteInboundMessage(u.id, 1000);
    noteInboundMessage(u.id, 1001);
    expect(checkQuota(u.id, 1002).allowed).toBe(true);
    noteInboundMessage(u.id, 1002);
    expect(checkQuota(u.id, 1002).allowed).toBe(false);
    expect(checkQuota(u.id, 1002).reason).toContain("过于频繁");
  });

  it("forgets messages outside the 60s window", () => {
    setEnv("ICLAW_USER_RATE_PER_MIN", "2");
    resetConfigCache();
    const u = createUser("u");
    noteInboundMessage(u.id, 1000);
    noteInboundMessage(u.id, 1001);
    expect(checkQuota(u.id, 1001).allowed).toBe(false);
    expect(checkQuota(u.id, 1001 + 61_000).allowed).toBe(true);
  });

  it("enforces a daily token budget", () => {
    setEnv("ICLAW_USER_DAILY_TOKEN_LIMIT", "100");
    resetConfigCache();
    const u = createUser("u");
    recordUsage(u.id, { input: 60, output: 30, cacheRead: 0, cacheWrite: 0, costTotal: 0 }, localDay());
    expect(checkQuota(u.id).allowed).toBe(true);
    recordUsage(u.id, { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, costTotal: 0 }, localDay());
    const decision = checkQuota(u.id);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("额度");
  });
});
