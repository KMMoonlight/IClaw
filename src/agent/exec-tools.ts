import fs from "node:fs";
import path from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";

import { loadConfig } from "../config.js";
import { planSandbox } from "./sandbox.js";
import { runShell } from "./shell.js";
import { resolveInWorkspace, workspaceForUser } from "./workspace.js";
import { logger } from "../logger.js";

/** Max characters of file/command output returned to the model. */
const TEXT_OUTPUT_LIMIT = 8000;
/** Max bytes accepted by write_file (content length). */
const WRITE_MAX_BYTES = 1_000_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

const ReadSchema = Type.Object({ path: Type.String(), maxBytes: Type.Optional(Type.Number()) });
type ReadParams = Static<typeof ReadSchema>;

const WriteSchema = Type.Object({ path: Type.String(), content: Type.String() });
type WriteParams = Static<typeof WriteSchema>;

const ListSchema = Type.Object({ path: Type.Optional(Type.String()) });
type ListParams = Static<typeof ListSchema>;

const BashSchema = Type.Object({ command: Type.String(), timeoutMs: Type.Optional(Type.Number()) });
type BashParams = Static<typeof BashSchema>;

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: { isError: true } };
}

function clampText(text: string): { text: string; truncated: boolean } {
  if (text.length <= TEXT_OUTPUT_LIMIT) return { text, truncated: false };
  return { text: `${text.slice(0, TEXT_OUTPUT_LIMIT)}\n…（输出过长已截断，完整长度 ${text.length} 字符）`, truncated: true };
}

/** `read_file` — read a UTF-8 file inside the user's workspace. */
function readFileTool(userId: string): AgentTool<typeof ReadSchema> {
  return {
    name: "read_file",
    label: "Read file",
    description: "读取工作目录内的一个文本文件（相对路径）。",
    parameters: ReadSchema,
    execute: async (_id, params: ReadParams) => {
      try {
        const abs = resolveInWorkspace(userId, params.path);
        const stat = fs.statSync(abs);
        if (!stat.isFile()) return errorResult(`不是文件：${params.path}`);
        const cap = params.maxBytes ?? loadConfig().execMaxOutputBytes;
        const raw = fs.readFileSync(abs).subarray(0, Math.max(0, cap)).toString("utf-8");
        return { content: [{ type: "text", text: raw || "(空文件)" }], details: {} };
      } catch (err) {
        return errorResult(`读取失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** `write_file` — write a UTF-8 file inside the user's workspace. */
function writeFileTool(userId: string): AgentTool<typeof WriteSchema> {
  return {
    name: "write_file",
    label: "Write file",
    description: "在工作目录内写入/覆盖一个文本文件（相对路径，自动创建上级目录）。",
    parameters: WriteSchema,
    execute: async (_id, params: WriteParams) => {
      try {
        const bytes = Buffer.byteLength(params.content, "utf-8");
        if (bytes > WRITE_MAX_BYTES) return errorResult(`内容过大（${bytes} 字节，上限 ${WRITE_MAX_BYTES}）。`);
        const abs = resolveInWorkspace(userId, params.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, params.content, "utf-8");
        return { content: [{ type: "text", text: `已写入 ${bytes} 字节：${params.path}` }], details: {} };
      } catch (err) {
        return errorResult(`写入失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** `list_dir` — list entries inside the user's workspace. */
function listDirTool(userId: string): AgentTool<typeof ListSchema> {
  return {
    name: "list_dir",
    label: "List directory",
    description: "列出工作目录内某个目录的内容（相对路径，默认根目录）。",
    parameters: ListSchema,
    execute: async (_id, params: ListParams) => {
      try {
        const abs = resolveInWorkspace(userId, params.path ?? ".");
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        if (entries.length === 0) return { content: [{ type: "text", text: "(空目录)" }], details: {} };
        const lines = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      } catch (err) {
        return errorResult(`列目录失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** `bash` — run a shell command in the user's workspace. */
function bashTool(userId: string): AgentTool<typeof BashSchema> {
  return {
    name: "bash",
    label: "Bash",
    description: "在用户工作目录中执行一条 shell 命令，返回退出码、标准输出与标准错误。",
    parameters: BashSchema,
    execute: async (_id, params: BashParams) => {
      const command = params.command.trim();
      if (!command) return errorResult("命令不能为空。");
      const cfg = loadConfig();
      const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, params.timeoutMs ?? cfg.execTimeoutMs));
      const workspace = workspaceForUser(userId);
      const { plan, reason } = planSandbox(command, workspace, {
        mode: cfg.execSandbox,
        allowNetwork: cfg.execAllowNetwork,
      });
      if (!plan && cfg.execSandbox === "required") {
        return errorResult(`沙箱不可用，已拒绝执行：${reason}`);
      }
      if (!plan) logger.warn(`exec: running bash WITHOUT sandbox (${reason})`);
      const result = await runShell(command, {
        cwd: workspace,
        timeoutMs,
        maxOutputBytes: cfg.execMaxOutputBytes,
        sandbox: plan ?? undefined,
      });
      const parts: string[] = [
        `exit=${result.exitCode ?? "?"}${result.signal ? ` signal=${result.signal}` : ""}${plan ? ` [${plan.kind}]` : " [no-sandbox]"}`,
      ];
      if (result.timedOut) parts.push(`（超时 ${timeoutMs}ms 已终止）`);
      if (result.truncated) parts.push("（输出超过上限已截断）");
      if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
      if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
      const { text } = clampText(parts.join("\n"));
      return { content: [{ type: "text", text }], details: {} };
    },
  };
}

/** Build the exec tool set (only registered when ICLAW_TOOLS_EXEC is enabled). */
export function buildExecTools(userId: string): AgentTool<any>[] {
  return [readFileTool(userId), writeFileTool(userId), listDirTool(userId), bashTool(userId)];
}
