import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { resetConfigCache } from "../config.js";
import { openDbInMemory } from "../db/index.js";
import { buildTools } from "./tools.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-exec-test-"));
const origWs = process.env.ICLAW_WORKSPACE_DIR;
const origExec = process.env.ICLAW_TOOLS_EXEC;
const origSandbox = process.env.ICLAW_EXEC_SANDBOX;
const origApproval = process.env.ICLAW_APPROVAL_TOOLS;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  openDbInMemory();
  process.env.ICLAW_WORKSPACE_DIR = root;
  process.env.ICLAW_TOOLS_EXEC = "true";
  process.env.ICLAW_EXEC_SANDBOX = "none";
  process.env.ICLAW_APPROVAL_TOOLS = ""; // execute directly in these tests
  resetConfigCache();
});

afterAll(() => {
  setEnv("ICLAW_WORKSPACE_DIR", origWs);
  setEnv("ICLAW_TOOLS_EXEC", origExec);
  setEnv("ICLAW_EXEC_SANDBOX", origSandbox);
  setEnv("ICLAW_APPROVAL_TOOLS", origApproval);
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

function tool(name: string): AgentTool<any> {
  const found = buildTools("u1", []).find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

async function run(name: string, params: Record<string, unknown>): Promise<string> {
  const result = await tool(name).execute("call-1", params as never);
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((c) => c.type === "text")?.text ?? "";
}

describe("tool gating", () => {
  it("omits exec tools when ICLAW_TOOLS_EXEC is disabled", () => {
    setEnv("ICLAW_TOOLS_EXEC", "false");
    resetConfigCache();
    const names = buildTools("u1", []).map((t) => t.name);
    expect(names).not.toContain("bash");
    expect(names).not.toContain("write_file");
  });

  it("registers exec tools when enabled", () => {
    const names = buildTools("u1", []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["bash", "read_file", "write_file", "list_dir"]));
  });
});

describe("file tools", () => {
  it("writes, reads and lists within the workspace", async () => {
    expect(await run("write_file", { path: "notes/a.txt", content: "你好" })).toContain("已写入");
    expect(await run("read_file", { path: "notes/a.txt" })).toBe("你好");
    const listing = await run("list_dir", { path: "notes" });
    expect(listing).toContain("a.txt");
  });

  it("rejects path traversal and absolute paths", async () => {
    expect(await run("write_file", { path: "../escape.txt", content: "x" })).toContain("越界");
    expect(await run("read_file", { path: "/etc/passwd" })).toContain("相对路径");
    expect(fs.existsSync(path.join(root, "escape.txt"))).toBe(false);
  });

  it("rejects oversized writes", async () => {
    const huge = "a".repeat(1_000_001);
    expect(await run("write_file", { path: "big.txt", content: huge })).toContain("过大");
  });

  it("reports a helpful error for a missing file", async () => {
    expect(await run("read_file", { path: "nope.txt" })).toContain("读取失败");
  });

  it("refuses to follow a symlink that escapes the workspace", async () => {
    const dir = path.join(root, "u1");
    fs.mkdirSync(dir, { recursive: true });
    const secret = path.join(root, "outside-secret.txt");
    fs.writeFileSync(secret, "outside");
    fs.symlinkSync(secret, path.join(dir, "link.txt"));
    expect(await run("read_file", { path: "link.txt" })).toContain("越界");
  });

  it("refuses to write through a dangling symlink pointing outside", async () => {
    const dir = path.join(root, "u1");
    fs.mkdirSync(dir, { recursive: true });
    const outsideDir = path.join(root, "outside-write");
    fs.mkdirSync(outsideDir, { recursive: true });
    const missingTarget = path.join(outsideDir, "created.txt");
    fs.symlinkSync(missingTarget, path.join(dir, "dangling.txt"));
    expect(await run("write_file", { path: "dangling.txt", content: "pwned" })).toContain("越界");
    expect(fs.existsSync(missingTarget)).toBe(false);
  });
});

describe("bash tool", () => {
  it("runs a command in the workspace and returns its output", async () => {
    await run("write_file", { path: "hello.txt", content: "hi" });
    const out = await run("bash", { command: "cat hello.txt" });
    expect(out).toContain("exit=0");
    expect(out).toContain("hi");
  });

  it("rejects an empty command", async () => {
    expect(await run("bash", { command: "   " })).toContain("不能为空");
  });

  it("reports non-zero exits", async () => {
    const out = await run("bash", { command: "exit 7" });
    expect(out).toContain("exit=7");
  });
});
