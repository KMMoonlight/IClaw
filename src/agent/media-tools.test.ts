import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const { sendMediaFile, resolveWeixinAccount, getContextToken } = vi.hoisted(() => ({
  sendMediaFile: vi.fn(),
  resolveWeixinAccount: vi.fn(),
  getContextToken: vi.fn(),
}));

vi.mock("../wechat/send-media.js", () => ({ sendMediaFile }));
vi.mock("../wechat/accounts.js", () => ({ resolveWeixinAccount }));
vi.mock("../wechat/context-token.js", () => ({ getContextToken }));

import { resetConfigCache } from "../config.js";
import { bindBotAccount, createUser, openDbInMemory } from "../db/index.js";
import { buildMediaTools } from "./media-tools.js";
import { workspaceForUser } from "./workspace.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-media-tools-test-"));
const origWs = process.env.ICLAW_WORKSPACE_DIR;
const origMax = process.env.ICLAW_SEND_MEDIA_MAX_BYTES;

beforeEach(() => {
  openDbInMemory();
  process.env.ICLAW_WORKSPACE_DIR = root;
  delete process.env.ICLAW_SEND_MEDIA_MAX_BYTES;
  resetConfigCache();
  sendMediaFile.mockReset().mockResolvedValue({ messageId: "m1", kind: "image" });
  resolveWeixinAccount.mockReset().mockReturnValue({ configured: true, baseUrl: "https://gw", token: "tok", cdnBaseUrl: "https://cdn" });
  getContextToken.mockReset().mockReturnValue("ctx");
});

afterAll(() => {
  if (origWs === undefined) delete process.env.ICLAW_WORKSPACE_DIR;
  else process.env.ICLAW_WORKSPACE_DIR = origWs;
  if (origMax === undefined) delete process.env.ICLAW_SEND_MEDIA_MAX_BYTES;
  else process.env.ICLAW_SEND_MEDIA_MAX_BYTES = origMax;
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

function tool(name: string, userId: string): AgentTool<any> {
  const found = buildMediaTools(userId).find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

async function run(name: string, params: Record<string, unknown>, userId: string): Promise<string> {
  const result = await tool(name, userId).execute("call-1", params as never);
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === "text")?.text ?? "";
}

function writeUserFile(userId: string, rel: string, content: string | Buffer): void {
  const dir = workspaceForUser(userId);
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("buildMediaTools", () => {
  it("registers send_file and send_image", () => {
    expect(buildMediaTools("u").map((t) => t.name)).toEqual(["send_file", "send_image"]);
  });
});

describe("send_file", () => {
  it("sends a workspace file to the bound WeChat", async () => {
    const u = createUser("u");
    bindBotAccount("acc-1", u.id, "wx-user-1");
    writeUserFile(u.id, "notes/report.pdf", "pdf-bytes");
    const text = await run("send_file", { path: "notes/report.pdf", caption: "报告" }, u.id);
    expect(text).toContain("已发送");
    expect(sendMediaFile).toHaveBeenCalledWith({
      filePath: path.join(root, u.id, "notes/report.pdf"),
      to: "wx-user-1",
      text: "报告",
      opts: { baseUrl: "https://gw", token: "tok", contextToken: "ctx" },
      cdnBaseUrl: "https://cdn",
    });
  });

  it("rejects path traversal and missing files", async () => {
    const u = createUser("u");
    bindBotAccount("acc-1", u.id, "wx-user-1");
    expect(await run("send_file", { path: "../secret.txt" }, u.id)).toContain("路径无效");
    expect(await run("send_file", { path: "nope.txt" }, u.id)).toContain("文件不存在");
    expect(sendMediaFile).not.toHaveBeenCalled();
  });

  it("reports when the user has no binding", async () => {
    const u = createUser("u");
    writeUserFile(u.id, "a.txt", "x");
    expect(await run("send_file", { path: "a.txt" }, u.id)).toContain("还没有绑定微信");
  });
});

describe("send_image", () => {
  it("sends an image file", async () => {
    const u = createUser("u");
    bindBotAccount("acc-1", u.id, "wx-user-1");
    writeUserFile(u.id, "chart.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(await run("send_image", { path: "chart.png" }, u.id)).toContain("已发送");
    expect(sendMediaFile).toHaveBeenCalled();
  });

  it("rejects non-image files", async () => {
    const u = createUser("u");
    bindBotAccount("acc-1", u.id, "wx-user-1");
    writeUserFile(u.id, "doc.pdf", "x");
    expect(await run("send_image", { path: "doc.pdf" }, u.id)).toContain("不是图片");
    expect(sendMediaFile).not.toHaveBeenCalled();
  });
});
