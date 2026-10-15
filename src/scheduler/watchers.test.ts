import { beforeEach, describe, expect, it } from "vitest";

import { createUser, openDbInMemory } from "../db/index.js";
import {
  DEFAULT_WATCH_INTERVAL_MS,
  countActiveWatchers,
  createWatcher,
  deleteWatcher,
  getWatcher,
  listWatchers,
  listWatchersToCheck,
  recordWatcherCheck,
  setWatcherStatus,
  touchWatcherCheck,
} from "./watchers.js";

beforeEach(() => {
  openDbInMemory();
});

function make(userId: string, prompt = "p") {
  return createWatcher({ userId, kind: "web_change", spec: JSON.stringify({ url: "https://example.com" }), prompt });
}

describe("watchers CRUD", () => {
  it("creates a watcher with defaults", () => {
    const u = createUser("u");
    const w = make(u.id);
    expect(w.status).toBe("active");
    expect(w.state).toBeNull();
    expect(w.intervalMs).toBe(DEFAULT_WATCH_INTERVAL_MS);
    expect(getWatcher(w.id)?.prompt).toBe("p");
  });

  it("lists per user and counts active", () => {
    const a = createUser("a");
    const b = createUser("b");
    make(a.id);
    make(a.id);
    make(b.id);
    expect(listWatchers(a.id)).toHaveLength(2);
    expect(listWatchers()).toHaveLength(3);
    expect(countActiveWatchers(a.id)).toBe(2);
    const w = listWatchers(a.id)[0]!;
    setWatcherStatus(w.id, "paused");
    expect(countActiveWatchers(a.id)).toBe(1);
  });

  it("deletes watchers", () => {
    const u = createUser("u");
    const w = make(u.id);
    expect(deleteWatcher(w.id)).toBe(true);
    expect(deleteWatcher(w.id)).toBe(false);
    expect(getWatcher(w.id)).toBeNull();
  });
});

describe("due checks", () => {
  it("treats never-checked watchers as due and respects the interval", () => {
    const u = createUser("u");
    const w = createWatcher({
      userId: u.id,
      kind: "web_change",
      spec: JSON.stringify({ url: "https://example.com" }),
      prompt: "p",
      intervalMs: 1000,
    });
    expect(listWatchersToCheck(1000)).toHaveLength(1);
    recordWatcherCheck(w.id, "state-1", 1000);
    expect(listWatchersToCheck(1500)).toHaveLength(0);
    expect(listWatchersToCheck(2000)).toHaveLength(1);
  });

  it("ignores paused watchers", () => {
    const u = createUser("u");
    const w = make(u.id);
    setWatcherStatus(w.id, "paused");
    expect(listWatchersToCheck(Date.now())).toHaveLength(0);
  });

  it("touchWatcherCheck updates only the check time", () => {
    const u = createUser("u");
    const w = make(u.id);
    recordWatcherCheck(w.id, "keep-me", 1000);
    touchWatcherCheck(w.id, 2000);
    const reloaded = getWatcher(w.id)!;
    expect(reloaded.state).toBe("keep-me");
    expect(reloaded.lastCheckedAt).toBe(2000);
  });
});
