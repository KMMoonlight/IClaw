import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { buildTools, htmlToText, isPrivateHost } from "./tools.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function webFetchTool(): AgentTool<any> {
  const tool = buildTools("u1", []).find((t) => t.name === "web_fetch");
  if (!tool) throw new Error("web_fetch tool not registered");
  return tool;
}

async function execute(params: Record<string, unknown>): Promise<string> {
  const result = await webFetchTool().execute("call-1", params as never);
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === "text")?.text ?? "";
}

describe("buildTools", () => {
  it("registers the built-in tools", () => {
    const names = buildTools("u1", []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["remember", "forget", "read_skill", "web_fetch"]));
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
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const host of ["example.com", "api.deepseek.com", "8.8.8.8", "140.82.112.3"]) {
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
  });

  it("refuses private addresses", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const text = await execute({ url: "http://127.0.0.1:8080/admin" });
    expect(text).toContain("安全");
    expect(text).toContain("127.0.0.1");
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
