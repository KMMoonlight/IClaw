import { Type } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { appendUserMemory, getUser, setUserMemory } from "../db/index.js";
import { getSkill } from "./skills.js";

const RememberSchema = Type.Object({ fact: Type.String() });
type RememberParams = Static<typeof RememberSchema>;

const ForgetSchema = Type.Object({});

const ReadSkillSchema = Type.Object({ name: Type.String() });
type ReadSkillParams = Static<typeof ReadSkillSchema>;

const WebFetchSchema = Type.Object({
  url: Type.String(),
  maxBytes: Type.Optional(Type.Number()),
});
type WebFetchParams = Static<typeof WebFetchSchema>;

/** `remember` — append a fact to the current user's memory. */
function rememberTool(userId: string): AgentTool<typeof RememberSchema> {
  return {
    name: "remember",
    label: "Remember",
    description: "记住关于当前用户的一条事实，供以后对话使用。",
    parameters: RememberSchema,
    execute: async (_id, params: RememberParams) => {
      appendUserMemory(userId, params.fact);
      return { content: [{ type: "text", text: `已记住：${params.fact}` }], details: {} };
    },
  };
}

/** `forget` — clear the current user's memory. */
function forgetTool(userId: string): AgentTool<typeof ForgetSchema> {
  return {
    name: "forget",
    label: "Forget",
    description: "清除关于当前用户的全部记忆。",
    parameters: ForgetSchema,
    execute: async () => {
      setUserMemory(userId, "");
      return { content: [{ type: "text", text: "已清除该用户的记忆。" }], details: {} };
    },
  };
}

/** `read_skill` — load a skill's full instructions on demand. */
function readSkillTool(): AgentTool<typeof ReadSkillSchema> {
  return {
    name: "read_skill",
    label: "Read skill",
    description: "按名称加载一个技能的完整说明（SKILL.md 内容）。",
    parameters: ReadSkillSchema,
    execute: async (_id, params: ReadSkillParams) => {
      const skill = getSkill(params.name);
      if (!skill) {
        return { content: [{ type: "text", text: `未找到技能：${params.name}` }], details: {} };
      }
      return { content: [{ type: "text", text: skill.body }], details: {} };
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

/** Reject hosts that resolve into the local machine / private networks (SSRF guard). */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "" || host === "0.0.0.0" || host === "::" || host === "::1") {
    return true;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

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

async function fetchUrlWithGuards(rawUrl: string, maxBytes: number): Promise<{ text: string; finalUrl: string; contentType: string }> {
  let url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`不支持的协议：${url.protocol}（只允许 http/https）`);
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error(`出于安全考虑，不允许访问内网/本机地址：${url.hostname}`);
  }

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
      url = new URL(res.headers.get("location")!, url);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`重定向到不支持的协议：${url.protocol}`);
      if (isPrivateHost(url.hostname)) throw new Error(`重定向目标为内网地址，已阻止：${url.hostname}`);
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
          content: [{ type: "text", text: `[${finalUrl}]\n${truncated || "(empty)"}` }],
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

/**
 * Build the shared tool set for a user. Tools are identical across users
 * (same name/description/schema); the memory tools are bound to `userId` so
 * their side effects land in the right profile.
 */
export function buildTools(userId: string, extraTools: AgentTool<any>[] = []): AgentTool<any>[] {
  return [rememberTool(userId), forgetTool(userId), readSkillTool(), webFetchTool(), ...extraTools];
}

export function currentUserMemory(userId: string): string {
  return getUser(userId)?.memory ?? "";
}
