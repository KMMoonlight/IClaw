import { beforeEach, describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { createUser, openDbInMemory } from "../db/index.js";
import { createWatcher, listWatchers } from "../scheduler/watchers.js";
import { MAX_WATCHERS_PER_USER, buildWatchTools } from "./watch-tools.js";

beforeEach(() => {
  openDbInMemory();
});

function tool(name: string, userId: string): AgentTool<any> {
  const found = buildWatchTools(userId).find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

async function run(name: string, params: Record<string, unknown>, userId: string): Promise<string> {
  const result = await tool(name, userId).execute("call-1", params as never);
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === "text")?.text ?? "";
}

describe("buildWatchTools", () => {
  it("registers the three watcher tools", () => {
    expect(buildWatchTools("u").map((t) => t.name)).toEqual(["watch_url", "list_watchers", "cancel_watcher"]);
  });
});

describe("watch_url", () => {
  it("creates a content-change watcher by default", async () => {
    const u = createUser("u");
    expect(await run("watch_url", { url: "https://example.com", prompt: "有更新告诉我" }, u.id)).toContain("已开始监控");
    const watchers = listWatchers(u.id);
    expect(watchers).toHaveLength(1);
    expect(watchers[0]!.kind).toBe("web_change");
  });

  it("creates a keyword watcher when a keyword is given", async () => {
    const u = createUser("u");
    await run("watch_url", { url: "https://shop.example.com", prompt: "有货了", keyword: "有货" }, u.id);
    expect(listWatchers(u.id)[0]!.kind).toBe("web_keyword");
  });

  it("rejects empty prompts and invalid urls", async () => {
    const u = createUser("u");
    expect(await run("watch_url", { url: "https://x", prompt: "  " }, u.id)).toContain("不能为空");
    expect(await run("watch_url", { url: "ftp://x", prompt: "p" }, u.id)).toContain("无法监控");
    expect(listWatchers(u.id)).toHaveLength(0);
  });

  it("enforces the per-user cap", async () => {
    const u = createUser("u");
    for (let i = 0; i < MAX_WATCHERS_PER_USER; i++) {
      createWatcher({ userId: u.id, kind: "web_change", spec: JSON.stringify({ url: "https://x" }), prompt: `w${i}` });
    }
    expect(await run("watch_url", { url: "https://y", prompt: "one more" }, u.id)).toContain("最多");
  });
});

describe("list_watchers / cancel_watcher", () => {
  it("lists none, then shows watchers and cancels an owned one", async () => {
    const u = createUser("u");
    const other = createUser("other");
    expect(await run("list_watchers", {}, u.id)).toContain("暂无");
    await run("watch_url", { url: "https://example.com", prompt: "更新" }, u.id);
    expect(await run("list_watchers", {}, u.id)).toContain("example.com");
    const watcher = listWatchers(u.id)[0]!;

    expect(await run("cancel_watcher", { id: watcher.id }, other.id)).toContain("未找到");
    expect(listWatchers(u.id)).toHaveLength(1);
    expect(await run("cancel_watcher", { id: watcher.id }, u.id)).toContain("已取消");
    expect(listWatchers(u.id)).toHaveLength(0);
  });
});
