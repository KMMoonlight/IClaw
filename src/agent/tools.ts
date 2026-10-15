import { Type } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { addMemory, clearUserMemories, deleteMemory, findMemoryByContent, getUserDisabledTools, isSkillEnabledGlobally, listMemories, getUserDisabledSkills } from "../db/index.js";
import { loadConfig } from "../config.js";
import { withApproval } from "./approvals.js";
import { buildExecTools } from "./exec-tools.js";
import { buildMediaTools } from "./media-tools.js";
import { formatMemories } from "./memory.js";
import { buildScheduleTools } from "./schedule-tools.js";
import { getSkill } from "./skills.js";
import { buildWatchTools } from "./watch-tools.js";
import { wrapUntrusted } from "./security.js";
import { assertPublicHost } from "./net-guard.js";
import { searchEnabled, searchWeb } from "./web-search.js";

export { isPrivateHost } from "./net-guard.js";

const MEMORY_KINDS = ["fact", "preference", "event", "profile"] as const;

const RememberSchema = Type.Object({
  fact: Type.String(),
  kind: Type.Optional(Type.String()),
  importance: Type.Optional(Type.Number()),
});
type RememberParams = Static<typeof RememberSchema>;

const ForgetSchema = Type.Object({
  content: Type.Optional(Type.String()),
});
type ForgetParams = Static<typeof ForgetSchema>;

const ListMemoriesSchema = Type.Object({});

const ReadSkillSchema = Type.Object({ name: Type.String() });
type ReadSkillParams = Static<typeof ReadSkillSchema>;

const WebFetchSchema = Type.Object({
  url: Type.String(),
  maxBytes: Type.Optional(Type.Number()),
});
type WebFetchParams = Static<typeof WebFetchSchema>;

const WebSearchSchema = Type.Object({
  query: Type.String(),
  count: Type.Optional(Type.Number()),
});
type WebSearchParams = Static<typeof WebSearchSchema>;

/** `remember` — store a fact/preference about the current user (de-duplicated). */
function rememberTool(userId: string): AgentTool<typeof RememberSchema> {
  return {
    name: "remember",
    label: "Remember",
    description:
      "记住关于当前用户的一条事实，供以后对话使用。kind 可选 fact/preference/event/profile，importance 为 0-1 的重要度。",
    parameters: RememberSchema,
    execute: async (_id, params: RememberParams) => {
      const fact = params.fact.trim();
      if (!fact) {
        return { content: [{ type: "text", text: "没有可记住的内容。" }], details: { isError: true } };
      }
      const existing = findMemoryByContent(userId, fact);
      if (existing) {
        return { content: [{ type: "text", text: `已记住（已存在）：${fact}` }], details: {} };
      }
      const kind = params.kind && (MEMORY_KINDS as readonly string[]).includes(params.kind) ? params.kind : "fact";
      const importance = Math.min(1, Math.max(0, params.importance ?? 0.5));
      addMemory(userId, fact, { kind, source: "user", importance });
      return { content: [{ type: "text", text: `已记住：${fact}` }], details: {} };
    },
  };
}

/**
 * `forget` — delete one memory by content, or clear everything when no content
 * is given (backwards compatible with the old blanket-forget behaviour).
 */
function forgetTool(userId: string): AgentTool<typeof ForgetSchema> {
  return {
    name: "forget",
    label: "Forget",
    description: "遗忘关于当前用户的记忆：给定 content 时只删除匹配的那条，否则清空全部记忆。",
    parameters: ForgetSchema,
    execute: async (_id, params: ForgetParams) => {
      const content = params.content?.trim();
      if (content) {
        const existing = findMemoryByContent(userId, content);
        if (!existing) {
          return { content: [{ type: "text", text: `未找到相关记忆：${content}` }], details: {} };
        }
        deleteMemory(existing.id);
        return { content: [{ type: "text", text: `已忘记：${existing.content}` }], details: {} };
      }
      clearUserMemories(userId);
      return { content: [{ type: "text", text: "已清除该用户的全部记忆。" }], details: {} };
    },
  };
}

/** `list_memories` — show everything currently remembered about the user. */
function listMemoriesTool(userId: string): AgentTool<typeof ListMemoriesSchema> {
  return {
    name: "list_memories",
    label: "List memories",
    description: "列出当前关于该用户的全部记忆。",
    parameters: ListMemoriesSchema,
    execute: async () => {
      const memories = listMemories(userId);
      if (memories.length === 0) {
        return { content: [{ type: "text", text: "（暂无记忆）" }], details: {} };
      }
      return { content: [{ type: "text", text: formatMemories(memories) }], details: {} };
    },
  };
}

/** `read_skill` — load a skill's full instructions on demand. */
function readSkillTool(userId: string): AgentTool<typeof ReadSkillSchema> {
  return {
    name: "read_skill",
    label: "Read skill",
    description: "按名称加载一个技能的完整说明（SKILL.md 内容）。",
    parameters: ReadSkillSchema,
    execute: async (_id, params: ReadSkillParams) => {
      if (!isSkillEnabledGlobally(params.name) || getUserDisabledSkills(userId).includes(params.name)) {
        return { content: [{ type: "text", text: `技能已停用：${params.name}` }], details: { isError: true } };
      }
      const skill = getSkill(params.name);
      if (!skill) {
        return { content: [{ type: "text", text: `未找到技能：${params.name}` }], details: {} };
      }
      const notes: string[] = [];
      if (skill.allowedTools?.length) notes.push(`需要的工具：${skill.allowedTools.join(", ")}`);
      if (skill.requires?.length) notes.push(`运行依赖：${skill.requires.join(", ")}`);
      const text = notes.length ? `（${notes.join("；")}）\n\n${skill.body}` : skill.body;
      return { content: [{ type: "text", text }], details: {} };
    },
  };
}

// ---------------------------------------------------------------------------
// web_fetch（内置联网工具；官方 @modelcontextprotocol/server-fetch 已从 npm
// 下架，故内置实现，带 SSRF 防护）
// ---------------------------------------------------------------------------

const WEB_FETCH_TIMEOUT_MS = 15_000;
const WEB_FETCH_DEFAULT_MAX_BYTES = 500_000;
const WEB_FETCH_MAX_REDIRECTS = 3;
const WEB_FETCH_TEXT_LIMIT = 8_000;

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchUrlWithGuards(rawUrl: string, maxBytes: number): Promise<{ text: string; finalUrl: string; contentType: string }> {
  let url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`不支持的协议：${url.protocol}（只允许 http/https）`);
  }
  // Resolve DNS and reject loopback/private targets before any request (SSRF guard).
  await assertPublicHost(url.hostname);

  let redirects = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: controller.signal, redirect: "manual", headers: { "user-agent": "IClaw/1.0 web_fetch" } });
    } catch (err) {
      const msg = err instanceof Error && err.name === "AbortError" ? "抓取超时" : String(err);
      throw new Error(`抓取失败：${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      redirects += 1;
      if (redirects > WEB_FETCH_MAX_REDIRECTS) throw new Error("重定向次数过多");
      void res.body?.cancel().catch(() => {}); // release the redirect response socket
      url = new URL(res.headers.get("location")!, url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`重定向到不支持的协议：${url.protocol}`);
      await assertPublicHost(url.hostname);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = res.headers.get("content-type") ?? "";
    const reader = res.body?.getReader();
    if (!reader) return { text: "", finalUrl: url.toString(), contentType };
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`响应超过 ${maxBytes} 字节上限`);
      chunks.push(Buffer.from(value));
    }
    const raw = Buffer.concat(chunks, total).toString("utf-8");
    const text = contentType.includes("html") ? htmlToText(raw) : raw;
    return { text, finalUrl: url.toString(), contentType };
  }
}

/** `web_fetch` — fetch a URL and return its text content (SSRF-guarded, size/time limited). */
function webFetchTool(): AgentTool<typeof WebFetchSchema> {
  return {
    name: "web_fetch",
    label: "Web fetch",
    description:
      "抓取一个网页/接口的文本内容。仅支持 http/https 公网地址（内网/本机地址会被拒绝）；自动跟随最多 3 次重定向；HTML 会转为纯文本；默认最多读取 500KB。",
    parameters: WebFetchSchema,
    execute: async (_id, params: WebFetchParams) => {
      const maxBytes = params.maxBytes ?? WEB_FETCH_DEFAULT_MAX_BYTES;
      try {
        const { text, finalUrl } = await fetchUrlWithGuards(params.url, Math.min(maxBytes, 5_000_000));
        const truncated = text.length > WEB_FETCH_TEXT_LIMIT ? `${text.slice(0, WEB_FETCH_TEXT_LIMIT)}\n…（内容过长已截断，完整长度 ${text.length} 字符）` : text;
        return {
          content: [{ type: "text", text: wrapUntrusted(finalUrl, truncated || "(empty)") }],
          details: {},
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `web_fetch 失败：${err instanceof Error ? err.message : String(err)}` }],
          details: { isError: true },
        };
      }
    },
  };
}

/** `web_search` — query the configured search backend (only registered when configured). */
function webSearchTool(): AgentTool<typeof WebSearchSchema> {
  return {
    name: "web_search",
    label: "Web search",
    description: "联网搜索，返回结果的标题、链接与摘要（用于查找最新信息）。",
    parameters: WebSearchSchema,
    execute: async (_id, params: WebSearchParams) => {
      const query = params.query.trim();
      if (!query) return { content: [{ type: "text", text: "搜索词不能为空。" }], details: { isError: true } };
      try {
        const results = await searchWeb(query, { count: params.count });
        if (results.length === 0) return { content: [{ type: "text", text: "（没有搜索结果）" }], details: {} };
        const text = results
          .map((r, i) => `${i + 1}. ${r.title}\n${r.url}${r.snippet ? `\n${r.snippet}` : ""}`)
          .join("\n\n");
        return { content: [{ type: "text", text: wrapUntrusted(`web_search: ${query}`, text) }], details: {} };
      } catch (err) {
        return {
          content: [{ type: "text", text: `web_search 失败：${err instanceof Error ? err.message : String(err)}` }],
          details: { isError: true },
        };
      }
    },
  };
}

/**
 * Build the shared tool set for a user. Tools are identical across users
 * (same name/description/schema); the memory tools are bound to `userId` so
 * their side effects land in the right profile.
 */
export function buildTools(userId: string, extraTools: AgentTool<any>[] = []): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [
    rememberTool(userId),
    forgetTool(userId),
    listMemoriesTool(userId),
    readSkillTool(userId),
    webFetchTool(),
    ...buildScheduleTools(userId),
    ...buildWatchTools(userId),
    ...buildMediaTools(userId),
  ];
  // Exec tools (bash / files) are opt-in and confined to the user's workspace.
  if (loadConfig().toolsExec) tools.push(...buildExecTools(userId));
  // Web search is only offered when a backend is configured.
  if (searchEnabled()) tools.push(webSearchTool());
  // Per-user tool policy: drop any tool the admin disabled for this user.
  let disabled = new Set<string>();
  try {
    disabled = new Set(getUserDisabledTools(userId));
  } catch {
    // DB not ready (e.g. isolated tests) — treat as no policy.
  }
  const enabled = [...tools, ...extraTools].filter((t) => !disabled.has(t.name));
  // Wrap dangerous tools so the user must confirm before they run.
  const approval = new Set(loadConfig().approvalTools);
  return enabled.map((t) => (approval.has(t.name) ? withApproval(userId, t) : t));
}

export function currentUserMemory(userId: string): string {
  return formatMemories(listMemories(userId));
}
