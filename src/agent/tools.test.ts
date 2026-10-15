import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { resetConfigCache } from "../config.js";
import { createUser, listMemories, openDbInMemory, setUserDisabledTools } from "../db/index.js";
import { buildTools, htmlToText, isPrivateHost } from "./tools.js";
import { setHostLookup } from "./net-guard.js";

beforeEach(() => {
  openDbInMemory();
  // Keep unit tests off the network: pretend every domain resolves to a public IP.
  setHostLookup(async () => ["93.184.216.34"]);
});

afterEach(() => {
  setHostLookup(null);
  vi.unstubAllGlobals();
});

function tool(name: string, userId = "u1"): AgentTool<any> {
  const found = buildTools(userId, []).find((t) => t.name === name);
  if (!found) throw new Error(`${name} tool not registered`);
  return found;
}

async function run(name: string, params: Record<string, unknown>, userId = "u1"): Promise<string> {
  const result = await tool(name, userId).execute("call-1", params as never);
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === "text")?.text ?? "";
}

async function execute(params: Record<string, unknown>): Promise<string> {
  return run("web_fetch", params);
}

describe("buildTools", () => {
  it("registers the built-in tools", () => {
    const names = buildTools("u1", []).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["remember", "forget", "list_memories", "read_skill", "web_fetch"]),
    );
  });

  it("omits tools disabled by the user's policy", () => {
    const u = createUser("u");
    setUserDisabledTools(u.id, ["web_fetch", "remember"]);
    const names = buildTools(u.id, []).map((t) => t.name);
    expect(names).not.toContain("web_fetch");
    expect(names).not.toContain("remember");
    expect(names).toContain("list_memories");
  });

  it("registers web_search only when a backend is configured", () => {
    const savedProvider = process.env.ICLAW_SEARCH_PROVIDER;
    const savedBase = process.env.ICLAW_SEARCH_BASE_URL;
    try {
      expect(buildTools("u1", []).map((t) => t.name)).not.toContain("web_search");
      process.env.ICLAW_SEARCH_PROVIDER = "searxng";
      process.env.ICLAW_SEARCH_BASE_URL = "https://searx.example";
      resetConfigCache();
      expect(buildTools("u1", []).map((t) => t.name)).toContain("web_search");
    } finally {
      if (savedProvider === undefined) delete process.env.ICLAW_SEARCH_PROVIDER;
      else process.env.ICLAW_SEARCH_PROVIDER = savedProvider;
      if (savedBase === undefined) delete process.env.ICLAW_SEARCH_BASE_URL;
      else process.env.ICLAW_SEARCH_BASE_URL = savedBase;
      resetConfigCache();
    }
  });
});

describe("memory tools", () => {
  it("remembers a fact with defaults and de-duplicates", async () => {
    const u = createUser("u");
    expect(await run("remember", { fact: "喜欢美式" }, u.id)).toContain("已记住");
    expect(await run("remember", { fact: "喜欢美式" }, u.id)).toContain("已存在");
    const memories = listMemories(u.id);
    expect(memories).toHaveLength(1);
    expect(memories[0]!.kind).toBe("fact");
    expect(memories[0]!.source).toBe("user");
  });

  it("honours kind and importance, ignoring unknown kinds", async () => {
    const u = createUser("u");
    await run("remember", { fact: "常住上海", kind: "profile", importance: 0.9 }, u.id);
    await run("remember", { fact: "随便", kind: "bogus" }, u.id);
    const [a, b] = listMemories(u.id);
    expect(a!.kind).toBe("profile");
    expect(a!.importance).toBe(0.9);
    expect(b!.kind).toBe("fact");
  });

  it("rejects empty content", async () => {
    const u = createUser("u");
    expect(await run("remember", { fact: "   " }, u.id)).toContain("没有可记住");
    expect(listMemories(u.id)).toHaveLength(0);
  });

  it("forgets a single memory by content, or everything without content", async () => {
    const u = createUser("u");
    await run("remember", { fact: "a" }, u.id);
    await run("remember", { fact: "b" }, u.id);
    expect(await run("forget", { content: "a" }, u.id)).toContain("已忘记");
    expect(listMemories(u.id).map((m) => m.content)).toEqual(["b"]);
    expect(await run("forget", { content: "missing" }, u.id)).toContain("未找到");
    expect(await run("forget", {}, u.id)).toContain("全部记忆");
    expect(listMemories(u.id)).toEqual([]);
  });

  it("lists memories or reports none", async () => {
    const u = createUser("u");
    expect(await run("list_memories", {}, u.id)).toContain("暂无记忆");
    await run("remember", { fact: "事实一", kind: "event" }, u.id);
    expect(await run("list_memories", {}, u.id)).toBe("- [event] 事实一");
  });
});

describe("isPrivateHost", () => {
  it("blocks local and private addresses", () => {
    for (const host of [
      "localhost",
      "foo.localhost",
      "127.0.0.1",
      "0.0.0.0",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const host of ["example.com", "api.deepseek.com", "8.8.8.8", "140.82.112.3", "2606:4700::1111"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

describe("htmlToText", () => {
  it("strips tags, scripts and collapses whitespace", () => {
    const html = `
      <html><head><title>t</title></head><body>
        <script>var x = 1;</script>
        <h1>标题</h1><p>正文 &amp; 更多</p>
      </body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("标题");
    expect(text).toContain("正文 & 更多");
    expect(text).not.toContain("<");
    expect(text).not.toContain("var x");
  });
});

describe("web_fetch tool", () => {
  it("fetches a public URL and extracts HTML text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html><body><p>你好，世界</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    );
    const text = await execute({ url: "https://example.com/page" });
    expect(text).toContain("你好，世界");
    expect(text).toContain("https://example.com/page");
    expect(text).toContain("外部不可信");
  });

  it("refuses private addresses", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const text = await execute({ url: "http://127.0.0.1:8080/admin" });
    expect(text).toContain("安全");
    expect(text).toContain("127.0.0.1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a public hostname that resolves to a private IP (DNS rebinding)", async () => {
    setHostLookup(async () => ["127.0.0.1"]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const text = await execute({ url: "https://metadata.example.com/latest" });
    expect(text).toContain("内网");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks IPv6-mapped loopback literals", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const text = await execute({ url: "http://[::ffff:127.0.0.1]/" });
    expect(text).toContain("安全");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses redirects into private networks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("", { status: 302, headers: { location: "http://192.168.1.1/secret" } }),
      ),
    );
    const text = await execute({ url: "https://example.com/go" });
    expect(text).toContain("内网");
    expect(text).toContain("192.168.1.1");
  });

  it("rejects unsupported protocols", async () => {
    const text = await execute({ url: "file:///etc/passwd" });
    expect(text).toContain("协议");
  });

  it("surfaces HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));
    const text = await execute({ url: "https://example.com/missing" });
    expect(text).toContain("404");
  });

  it("enforces the byte cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("0123456789abcdef", { status: 200, headers: { "content-type": "text/plain" } })),
    );
    const text = await execute({ url: "https://example.com/big", maxBytes: 8 });
    expect(text).toContain("上限");
  });
});
