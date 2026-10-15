import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";

import { parseWatcherSpec } from "../scheduler/triggers.js";
import {
  countActiveWatchers,
  createWatcher,
  deleteWatcher,
  getWatcher,
  listWatchers,
} from "../scheduler/watchers.js";
import type { Watcher } from "../scheduler/watchers.js";

/** Guard against runaway watcher creation per user. */
export const MAX_WATCHERS_PER_USER = 10;

const WatchSchema = Type.Object({
  url: Type.String(),
  prompt: Type.String(),
  keyword: Type.Optional(Type.String()),
});
type WatchParams = Static<typeof WatchSchema>;

const ListSchema = Type.Object({});
const CancelSchema = Type.Object({ id: Type.String() });
type CancelParams = Static<typeof CancelSchema>;

export function formatWatcher(watcher: Watcher): string {
  const spec = parseWatcherSpec(watcher.spec);
  const kind = spec.keyword ? `关键词「${spec.keyword}」` : "内容变化";
  return `- [${watcher.id}] ${spec.url}（监控：${kind}）→ ${watcher.prompt}`;
}

/** `watch_url` — watch a web page and notify the user on change / keyword appear. */
function watchUrlTool(userId: string): AgentTool<typeof WatchSchema> {
  return {
    name: "watch_url",
    label: "Watch URL",
    description:
      "监控一个网页：默认监控内容变化，给定 keyword 时监控该关键词是否出现。一旦触发，会把 prompt 发给用户。适合「某网站有货/有新闻就通知我」。",
    parameters: WatchSchema,
    execute: async (_id, params: WatchParams) => {
      const prompt = params.prompt.trim();
      if (!prompt) {
        return { content: [{ type: "text", text: "触发内容（prompt）不能为空。" }], details: { isError: true } };
      }
      if (countActiveWatchers(userId) >= MAX_WATCHERS_PER_USER) {
        return {
          content: [{ type: "text", text: `最多只能同时监控 ${MAX_WATCHERS_PER_USER} 个页面，请先取消一些。` }],
          details: { isError: true },
        };
      }
      const keyword = params.keyword?.trim() || undefined;
      let normalizedUrl: string;
      try {
        normalizedUrl = parseWatcherSpec(JSON.stringify({ url: params.url, keyword })).url;
      } catch (err) {
        return {
          content: [{ type: "text", text: `无法监控该地址：${err instanceof Error ? err.message : String(err)}` }],
          details: { isError: true },
        };
      }
      const watcher = createWatcher({
        userId,
        kind: keyword ? "web_keyword" : "web_change",
        spec: JSON.stringify({ url: normalizedUrl, keyword }),
        prompt,
      });
      return {
        content: [{ type: "text", text: `已开始监控（${watcher.id}）：${normalizedUrl}` }],
        details: {},
      };
    },
  };
}

/** `list_watchers` — list the user's active URL watchers. */
function listWatchersTool(userId: string): AgentTool<typeof ListSchema> {
  return {
    name: "list_watchers",
    label: "List watchers",
    description: "列出当前用户的网页监控项。",
    parameters: ListSchema,
    execute: async () => {
      const watchers = listWatchers(userId).filter((w) => w.status === "active");
      if (watchers.length === 0) {
        return { content: [{ type: "text", text: "（暂无监控项）" }], details: {} };
      }
      return { content: [{ type: "text", text: watchers.map(formatWatcher).join("\n") }], details: {} };
    },
  };
}

/** `cancel_watcher` — stop watching a URL by id. */
function cancelWatcherTool(userId: string): AgentTool<typeof CancelSchema> {
  return {
    name: "cancel_watcher",
    label: "Cancel watcher",
    description: "按 id 取消当前用户的某个网页监控。",
    parameters: CancelSchema,
    execute: async (_id, params: CancelParams) => {
      const watcher = getWatcher(params.id.trim());
      if (!watcher || watcher.userId !== userId) {
        return { content: [{ type: "text", text: `未找到监控项：${params.id}` }], details: { isError: true } };
      }
      deleteWatcher(watcher.id);
      return { content: [{ type: "text", text: "已取消该监控。" }], details: {} };
    },
  };
}

/** Build the URL-watcher tool set bound to a user. */
export function buildWatchTools(userId: string): AgentTool<any>[] {
  return [watchUrlTool(userId), listWatchersTool(userId), cancelWatcherTool(userId)];
}
