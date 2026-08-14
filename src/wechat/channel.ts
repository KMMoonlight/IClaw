import { notifyStart, notifyStop } from "./api.js";
import { resolveWeixinAccount } from "./accounts.js";
import { restoreContextTokens } from "./context-token.js";
import type { InboundContext } from "./inbound.js";
import { monitorWeixin } from "./monitor.js";
import { logger } from "../logger.js";

/** Start the long-poll channel for a bot account, dispatching inbound to `onMessage`. */
export async function startWechatChannel(opts: {
  accountId?: string;
  onMessage: (ctx: InboundContext) => Promise<void>;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const account = resolveWeixinAccount(opts.accountId);
  if (!account.configured) {
    throw new Error("wechat not logged in — run `iclaw login` first");
  }
  const aLog = logger.withAccount(account.accountId);

  restoreContextTokens(account.accountId);

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
