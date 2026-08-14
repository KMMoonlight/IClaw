import { bindBotAccount, getBindingByUser, unbindBotAccount } from "../db/index.js";
import { logger } from "../logger.js";
import {
  clearWeixinAccount,
  normalizeAccountId,
  registerWeixinAccountId,
  saveWeixinAccount,
  unregisterWeixinAccountId,
} from "./accounts.js";
import { clearContextTokensForAccount } from "./context-token.js";
import type { LoginSession } from "./login-qr.js";

/**
 * Persist a confirmed login as a bot account and bind it to a user
 * (扫码即绑定：网关已把「扫码微信 ↔ bot 账号」1:1 锁定，这里只做落库关联)。
 * Replaces any previous binding for the same user.
 *
 * Returns the normalized account id.
 */
export function persistAndBind(session: LoginSession, userId: string, opts: {
  /** Stop the channel of the user's previous bot account, if any. */
  onReplaced?: (oldAccountId: string) => void;
} = {}): string {
  if (!session.accountId || !session.botToken) {
    throw new Error("登录会话缺少 bot 账号数据，无法绑定");
  }
  const accountId = normalizeAccountId(session.accountId);
  saveWeixinAccount(accountId, {
    token: session.botToken,
    baseUrl: session.baseUrl,
    userId: session.wechatUserId,
  });
  registerWeixinAccountId(accountId);

  const prev = getBindingByUser(userId);
  if (prev && prev.accountId !== accountId) {
    unbindBotAccount(prev.accountId);
    unregisterWeixinAccountId(prev.accountId);
    clearWeixinAccount(prev.accountId);
    clearContextTokensForAccount(prev.accountId);
    opts.onReplaced?.(prev.accountId);
    logger.info(`binding: replaced previous bot ${prev.accountId} for user ${userId}`);
  }

  bindBotAccount(accountId, userId, session.wechatUserId ?? "");
  logger.info(`binding: account ${accountId} (wechat ${session.wechatUserId ?? "?"}) -> user ${userId}`);
  return accountId;
}

/** Remove a user's bot binding and clean up the account (channel stop is the caller's job). */
export function unbindUserBot(userId: string, opts: {
  onRemoved?: (accountId: string) => void;
} = {}): boolean {
  const binding = getBindingByUser(userId);
  if (!binding) return false;
  unbindBotAccount(binding.accountId);
  unregisterWeixinAccountId(binding.accountId);
  clearWeixinAccount(binding.accountId);
  clearContextTokensForAccount(binding.accountId);
  opts.onRemoved?.(binding.accountId);
  logger.info(`binding: unbound account ${binding.accountId} from user ${userId}`);
  return true;
}
