// Adapted from Tencent/openclaw-weixin (MIT License). See docs/THIRD_PARTY_NOTICES.md.
import { getUpdates, classifyFetchError } from "./api.js";
import { findImageItem, weixinMessageToContext } from "./inbound.js";
import type { InboundContext } from "./inbound.js";
import { downloadImageFromItem } from "./media-download.js";
import { setContextToken } from "./context-token.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "./sync-buf.js";
import { logger } from "../logger.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
/** errcode -14 = session timeout (token stale). */
const STALE_TOKEN_ERRCODE = -14;

export type MonitorOpts = {
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  accountId: string;
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  onMessage: (ctx: InboundContext) => Promise<void>;
};

/** Long-poll loop: getUpdates -> parse -> onMessage. Runs until abort. */
export async function monitorWeixin(opts: MonitorOpts): Promise<void> {
  const { baseUrl, cdnBaseUrl, token, accountId, abortSignal, onMessage } = opts;
  const aLog = logger.withAccount(accountId);

  const syncFilePath = getSyncBufFilePath(accountId);
  let getUpdatesBuf = loadGetUpdatesBuf(syncFilePath) ?? "";

  let nextTimeoutMs = opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  aLog.info(`Monitor started: baseUrl=${baseUrl}`);

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
      if (isApiError) {
        const isStaleToken = resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE;
        if (isStaleToken) {
          aLog.error("getUpdates: token is stale — re-run login to reconnect this account");
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
          continue;
        }
        consecutiveFailures += 1;
        aLog.error(`getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      for (const msg of resp.msgs ?? []) {
        const from = msg.from_user_id ?? "";
        if (!from) continue;

        // Persist context token so outbound replies echo it verbatim.
        if (msg.context_token) setContextToken(accountId, from, msg.context_token);

        let media: InboundContext["media"];
        const imageItem = findImageItem(msg.item_list);
        if (imageItem) {
          media = (await downloadImageFromItem(imageItem, cdnBaseUrl)) ?? undefined;
        }

        const ctx = weixinMessageToContext(msg, accountId, media);
        aLog.info(`inbound from=${from} body=${ctx.body.slice(0, 80)} media=${Boolean(media)}`);
        await onMessage(ctx);
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        aLog.info("Monitor stopped (aborted)");
        return;
      }
      consecutiveFailures += 1;
      const classified = classifyFetchError(err);
      aLog.error(`getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)} type=${classified.type}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
  aLog.info("Monitor ended");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
