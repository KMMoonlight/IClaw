import { beforeEach, describe, expect, it, vi } from "vitest";

import { beginWork, endWork, inflightCount, onIdle, resetInflight, waitForIdle } from "./inflight.js";

beforeEach(() => resetInflight());

describe("inflight tracking", () => {
  it("counts concurrent work", () => {
    expect(inflightCount()).toBe(0);
    beginWork();
    beginWork();
    expect(inflightCount()).toBe(2);
    endWork();
    expect(inflightCount()).toBe(1);
    endWork();
    expect(inflightCount()).toBe(0);
    endWork(); // never goes negative
    expect(inflightCount()).toBe(0);
  });

  it("onIdle resolves immediately when idle", async () => {
    await expect(onIdle()).resolves.toBeUndefined();
  });

  it("onIdle resolves once the last unit finishes", async () => {
    beginWork();
    let resolved = false;
    const p = onIdle().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    endWork();
    await p;
    expect(resolved).toBe(true);
  });
});

describe("waitForIdle", () => {
  it("returns true immediately when idle", async () => {
    await expect(waitForIdle(1000)).resolves.toBe(true);
  });

  it("returns true when work drains in time", async () => {
    beginWork();
    const wait = waitForIdle(1000);
    setTimeout(() => endWork(), 10);
    await expect(wait).resolves.toBe(true);
  });

  it("returns false on timeout", async () => {
    vi.useFakeTimers();
    beginWork();
    const wait = waitForIdle(100);
    await vi.advanceTimersByTimeAsync(150);
    await expect(wait).resolves.toBe(false);
    vi.useRealTimers();
  });
});
