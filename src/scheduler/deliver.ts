import { runScheduledAgentTurn } from "../agent/runtime.js";
import { getBindingByUser } from "../db/index.js";
import { logger } from "../logger.js";
import { resolveWeixinAccount } from "../wechat/accounts.js";
import { getContextToken } from "../wechat/context-token.js";
import { sendTextMessage } from "../wechat/send.js";
import { parseTaskPayload } from "./tasks.js";
import type { ScheduledTask } from "./tasks.js";
import type { Watcher } from "./watchers.js";

/**
 * Push text to a user's WeChat bot. Returns false (without throwing) when the
 * user has no usable binding.
 */
export async function sendToUser(userId: string, text: string): Promise<boolean> {
  const binding = getBindingByUser(userId);
  if (!binding) {
    logger.warn(`scheduler: user ${userId} has no wechat binding, dropping delivery`);
    return false;
  }
  const account = resolveWeixinAccount(binding.accountId);
  if (!account.configured) {
    logger.warn(`scheduler: account ${binding.accountId} not configured, dropping delivery`);
    return false;
  }
  const contextToken = getContextToken(binding.accountId, binding.wechatUserId);
  await sendTextMessage({
    to: binding.wechatUserId,
    text,
    opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
  });
  logger.info(`scheduler: delivered message to user ${userId}`);
  return true;
}

/** Deliver a task's fixed prompt to the user. */
export async function deliverTaskMessage(task: ScheduledTask): Promise<boolean> {
  return sendToUser(task.userId, task.prompt);
}

/**
 * Execute a scheduled task:
 *  - "message" mode sends the prompt verbatim;
 *  - "agent" mode runs a proactive agent turn on the prompt and sends its reply.
 * Send failures propagate so the scheduler can report them.
 */
export async function runScheduledTask(task: ScheduledTask): Promise<boolean> {
  const { mode } = parseTaskPayload(task.payload);
  if (mode === "agent") {
    const reply = await runScheduledAgentTurn(task.userId, task.prompt);
    if (!reply.trim()) return false;
    return sendToUser(task.userId, reply);
  }
  return deliverTaskMessage(task);
}

/** Deliver a watcher's trigger notification to the user's WeChat bot. */
export async function handleWatcherChange(watcher: Watcher, detail?: string): Promise<boolean> {
  const text = detail ? `${watcher.prompt}\n\n${detail}` : watcher.prompt;
  return sendToUser(watcher.userId, text);
}
