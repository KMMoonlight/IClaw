import { notifyStart, notifyStop } from "./api.js";
import { listIndexedWeixinAccountIds, resolveWeixinAccount } from "./accounts.js";
import { restoreContextTokens } from "./context-token.js";
import type { InboundContext } from "./inbound.js";
import { purgeStaleInboundMedia } from "./media-download.js";
import { monitorWeixin } from "./monitor.js";
import { listBotBindings } from "../db/index.js";
import { logger } from "../logger.js";

interface RunningChannel {
  controller: AbortController;
  promise: Promise<void>;
}

const running = new Map<string, RunningChannel>();

/** Start the long-poll channel for a bot account, dispatching inbound to `onMessage`. */
export async function startWechatChannel(opts: {
  accountId?: string;
  onMessage: (ctx: InboundContext) => Promise<void>;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const account = resolveWeixinAccount(opts.accountId);
  if (!account.configured) {
    throw new Error("wechat not logged in — run the login/bind flow first");
  }
  const aLog = logger.withAccount(account.accountId);

  restoreContextTokens(account.accountId);
  purgeStaleInboundMedia();

  try {
    const resp = await notifyStart({ baseUrl: account.baseUrl, token: account.token });
    if (resp.ret !== undefined && resp.ret !== 0) {
      aLog.warn(`notifyStart ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`);
    }
  } catch (err) {
    aLog.warn(`notifyStart failed (ignored): ${String(err)}`);
  }

  try {
    await monitorWeixin({
      baseUrl: account.baseUrl,
      cdnBaseUrl: account.cdnBaseUrl,
      token: account.token,
      accountId: account.accountId,
      abortSignal: opts.abortSignal,
      onMessage: opts.onMessage,
    });
  } finally {
    try {
      const resp = await notifyStop({ baseUrl: account.baseUrl, token: account.token });
      if (resp.ret !== undefined && resp.ret !== 0) {
        aLog.warn(`notifyStop ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`);
      }
    } catch (err) {
      aLog.warn(`notifyStop failed (ignored): ${String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic channel manager（运行时按账号启停；绑定新用户即补一条通道）
// ---------------------------------------------------------------------------

export function isChannelRunning(accountId: string): boolean {
  return running.has(accountId);
}

export function listRunningChannels(): string[] {
  return [...running.keys()];
}

/** Start the channel for one account. No-op when already running. Fire-and-forget. */
export function startChannelForAccount(
  accountId: string,
  onMessage: (ctx: InboundContext) => Promise<void>,
): void {
  if (running.has(accountId)) return;
  if (!resolveWeixinAccount(accountId).configured) {
    logger.warn(`channel: account ${accountId} not configured, skip`);
    return;
  }
  const controller = new AbortController();
  const promise = startWechatChannel({ accountId, onMessage, abortSignal: controller.signal })
    .catch((err) => logger.error(`channel ${accountId} 异常退出：${String(err)}`))
    .finally(() => running.delete(accountId));
  running.set(accountId, { controller, promise });
  logger.info(`channel: started for account ${accountId}`);
}

/** Abort the channel of one account (waits for its monitor loop to settle). */
export function stopChannelForAccount(accountId: string): void {
  running.get(accountId)?.controller.abort();
}

/** Abort all channels. */
export function stopAllChannels(): void {
  for (const { controller } of running.values()) controller.abort();
}

/** Start channels for every bound bot account (serve/run mode). Returns the count started. */
export function startChannelsForBoundAccounts(
  onMessage: (ctx: InboundContext) => Promise<void>,
): number {
  const bindings = listBotBindings();
  if (bindings.length === 0) {
    logger.warn("无已绑定用户，跳过微信通道启动（先在 Web 端为用户生成绑定二维码）。");
    return 0;
  }
  let started = 0;
  for (const b of bindings) {
    const before = running.has(b.accountId);
    startChannelForAccount(b.accountId, onMessage);
    if (!before && running.has(b.accountId)) started += 1;
  }
  return started;
}

/** Start channels for every registered account, bound or not (echo 测试模式). */
export function startAllRegisteredChannels(
  onMessage: (ctx: InboundContext) => Promise<void>,
): void {
  const ids = listIndexedWeixinAccountIds();
  if (ids.length === 0) {
    throw new Error("weixin: no accounts registered — run the login flow first");
  }
  for (const id of ids) startChannelForAccount(id, onMessage);
}

/** Resolve when every currently-running channel has settled (after abort). */
export async function waitForAllChannels(): Promise<void> {
  await Promise.allSettled([...running.values()].map((r) => r.promise));
}
