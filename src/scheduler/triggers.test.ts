import { beforeEach, describe, expect, it, vi } from "vitest";

import { createUser, openDbInMemory } from "../db/index.js";
import { checkWatcher, fingerprint, parseWatcherSpec, runWatchers } from "./triggers.js";
import type { FetchTextFn } from "./triggers.js";
import { createWatcher, getWatcher } from "./watchers.js";

beforeEach(() => {
  openDbInMemory();
});

describe("parseWatcherSpec", () => {
  it("parses a valid spec and normalises the URL", () => {
    const spec = parseWatcherSpec(JSON.stringify({ url: "https://example.com/a", keyword: " 有货 " }));
    expect(spec.url).toBe("https://example.com/a");
    expect(spec.keyword).toBe(" 有货 ");
  });

  it("rejects malformed specs and non-http urls", () => {
    expect(() => parseWatcherSpec("not json")).toThrow("JSON");
    expect(() => parseWatcherSpec("{}")).toThrow("url");
    expect(() => parseWatcherSpec(JSON.stringify({ url: "ftp://x" }))).toThrow("http");
  });
});

describe("fingerprint", () => {
  it("is stable and content-sensitive", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
  });
});

describe("checkWatcher", () => {
  const fetchText: FetchTextFn = async (url) => ({ text: "hello", finalUrl: url });

  it("records a baseline on the first content check without firing", async () => {
    const result = await checkWatcher("web_change", JSON.stringify({ url: "https://x" }), null, fetchText);
    expect(result.changed).toBe(false);
    expect(result.state).toBe(fingerprint("hello"));
  });

  it("fires when content changes", async () => {
    const spec = JSON.stringify({ url: "https://x" });
    const first = await checkWatcher("web_change", spec, null, fetchText);
    const same = await checkWatcher("web_change", spec, first.state, async (u) => ({ text: "hello", finalUrl: u }));
    expect(same.changed).toBe(false);
    const changed = await checkWatcher("web_change", spec, first.state, async (u) => ({ text: "hello world", finalUrl: u }));
    expect(changed.changed).toBe(true);
    expect(changed.detail).toContain("https://x");
  });

  it("fires on the absent → present keyword transition", async () => {
    const spec = JSON.stringify({ url: "https://x", keyword: "有货" });
    const absent = await checkWatcher("web_keyword", spec, null, async (u) => ({ text: "无货", finalUrl: u }));
    expect(absent.state).toBe("absent");
    expect(absent.changed).toBe(false);

    const present = await checkWatcher("web_keyword", spec, "absent", async (u) => ({ text: "现在有货了", finalUrl: u }));
    expect(present.changed).toBe(true);
    expect(present.detail).toContain("有货");

    const stillPresent = await checkWatcher("web_keyword", spec, "present", async (u) => ({ text: "有货", finalUrl: u }));
    expect(stillPresent.changed).toBe(false);
  });
});

describe("runWatchers", () => {
  function watch(userId: string, prompt: string) {
    return createWatcher({
      userId,
      kind: "web_change",
      spec: JSON.stringify({ url: "https://example.com" }),
      prompt,
      intervalMs: 1000,
    });
  }

  it("checks due watchers, records state, and fires on change", async () => {
    const u = createUser("u");
    const w = watch(u.id, "变了");
    const seen: string[] = [];
    const fetchText: FetchTextFn = async (url) => ({ text: "v1", finalUrl: url });

    expect(await runWatchers((_w, detail) => void seen.push(detail ?? ""), { now: 1000, fetchText })).toBe(0);
    expect(getWatcher(w.id)!.state).toBe(fingerprint("v1"));

    const changed: FetchTextFn = async (url) => ({ text: "v2", finalUrl: url });
    expect(
      await runWatchers((_w, detail) => void seen.push(detail ?? ""), { now: 2000, fetchText: changed }),
    ).toBe(1);
    expect(seen[0]).toContain("内容已变化");
  });

  it("advances the check time but keeps state when the fetch fails", async () => {
    const u = createUser("u");
    const w = watch(u.id, "x");
    const onError = vi.fn();
    const boom: FetchTextFn = async () => {
      throw new Error("timeout");
    };
    expect(await runWatchers(() => {}, { now: 5000, fetchText: boom, onError })).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    const reloaded = getWatcher(w.id)!;
    expect(reloaded.lastCheckedAt).toBe(5000);
    expect(reloaded.state).toBeNull();
  });
});
