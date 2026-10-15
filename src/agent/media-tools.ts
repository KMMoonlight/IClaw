import fs from "node:fs";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";

import { loadConfig } from "../config.js";
import { getBindingByUser } from "../db/index.js";
import { logger } from "../logger.js";
import { resolveWeixinAccount } from "../wechat/accounts.js";
import { getContextToken } from "../wechat/context-token.js";
import { inferMimeType } from "../wechat/media-download.js";
import { sendMediaFile } from "../wechat/send-media.js";
import { resolveInWorkspace } from "./workspace.js";

const SendFileSchema = Type.Object({
  path: Type.String(),
  caption: Type.Optional(Type.String()),
});
type SendFileParams = Static<typeof SendFileSchema>;

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: { isError: true } };
}

/**
 * Send a file from the user's workspace to their WeChat. Shared by the
 * `send_file` / `send_image` tools; `requireImage` narrows `send_image`.
 */
async function sendWorkspaceFile(
  userId: string,
  relativePath: string,
  caption: string,
  requireImage: boolean,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  const binding = getBindingByUser(userId);
  if (!binding) return errorResult("当前用户还没有绑定微信，无法发送文件。");
  const account = resolveWeixinAccount(binding.accountId);
  if (!account.configured) return errorResult("该微信账号未登录，无法发送文件。");

  let absPath: string;
  try {
    absPath = resolveInWorkspace(userId, relativePath);
  } catch (err) {
    return errorResult(`路径无效：${err instanceof Error ? err.message : String(err)}`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return errorResult(`文件不存在：${relativePath}`);
  }
  if (!stat.isFile()) return errorResult(`不是文件：${relativePath}`);

  const mime = inferMimeType(absPath);
  if (requireImage && !mime.startsWith("image/")) {
    return errorResult(`不是图片文件：${relativePath}（${mime}）`);
  }
  if (stat.size > loadConfig().sendMediaMaxBytes) {
    return errorResult(`文件过大（${stat.size} 字节，上限 ${loadConfig().sendMediaMaxBytes}）。`);
  }

  try {
    const contextToken = getContextToken(binding.accountId, binding.wechatUserId);
    const { kind, messageId } = await sendMediaFile({
      filePath: absPath,
      to: binding.wechatUserId,
      text: caption,
      opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
      cdnBaseUrl: account.cdnBaseUrl,
    });
    logger.info(`media: sent ${kind} to user=${userId} (${messageId})`);
    return { content: [{ type: "text", text: `已发送${kind === "file" ? "文件" : kind === "image" ? "图片" : "视频"}：${relativePath}` }], details: {} };
  } catch (err) {
    logger.error(`media: send failed for user=${userId}: ${String(err)}`);
    return errorResult(`发送失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** `send_file` — send a workspace file to the user's WeChat. */
function sendFileTool(userId: string): AgentTool<typeof SendFileSchema> {
  return {
    name: "send_file",
    label: "Send file",
    description: "把工作目录内的一个文件（相对路径）发送给用户的微信（图片/视频/文件自动识别）。",
    parameters: SendFileSchema,
    execute: async (_id, params: SendFileParams) =>
      sendWorkspaceFile(userId, params.path, params.caption?.trim() ?? "", false),
  };
}

/** `send_image` — send a workspace image to the user's WeChat. */
function sendImageTool(userId: string): AgentTool<typeof SendFileSchema> {
  return {
    name: "send_image",
    label: "Send image",
    description: "把工作目录内的一张图片（相对路径）发送给用户的微信。",
    parameters: SendFileSchema,
    execute: async (_id, params: SendFileParams) =>
      sendWorkspaceFile(userId, params.path, params.caption?.trim() ?? "", true),
  };
}

/** Build the outbound-media tool set bound to a user. */
export function buildMediaTools(userId: string): AgentTool<any>[] {
  return [sendFileTool(userId), sendImageTool(userId)];
}
