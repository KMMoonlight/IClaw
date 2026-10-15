import { createHash } from "node:crypto";

import { fetchUrlWithGuards } from "../agent/tools.js";
import { logger } from "../logger.js";
import { listWatchersToCheck, recordWatcherCheck, touchWatcherCheck } from "./watchers.js";
import type { Watcher, WatcherKind } from "./watchers.js";

/** Cap the watched page size (reuses the same limit as web_fetch). */
const WATCH_MAX_BYTES = 500_000;

export interface WebSpec {
  url: string;
  keyword?: string;
}

export interface TriggerFetchResult {
  text: string;
  finalUrl: string;
}

export type FetchTextFn = (url: string) => Promise<TriggerFetchResult>;

/** Parse a watcher's JSON spec, validating the URL. */
export function parseWatcherSpec(spec: string): WebSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec);
  } catch {
    throw new Error(`watcher spec 不是合法 JSON：${spec}`);
  }
  const record = parsed as { url?: unknown; keyword?: unknown };
  if (typeof record.url !== "string" || record.url.trim() === "") {
    throw new Error("watcher spec 缺少 url");
  }
  const url = new URL(record.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`只支持 http/https：${record.url}`);
  }
  const keyword = typeof record.keyword === "string" && record.keyword.trim() !== "" ? record.keyword : undefined;
  return { url: url.toString(), keyword };
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Default fetcher: reuse the SSRF-guarded web_fetch pipeline (HTML → text). */
async function defaultFetchText(url: string): Promise<TriggerFetchResult> {
  const { text, finalUrl } = await fetchUrlWithGuards(url, WATCH_MAX_BYTES);
  return { text, finalUrl };
}

export interface CheckResult {
  state: string;
  changed: boolean;
  detail?: string;
}

/**
 * Evaluate one watcher against its previously recorded state.
 *  - `web_keyword`: fires on the absent → present transition of the keyword.
 *  - `web_change`: fires whenever the normalized content fingerprint differs from
 *    the last one (the very first check only records the baseline).
 */
export async function checkWatcher(
  kind: WatcherKind,
  spec: string,
  previousState: string | null,
  fetchText: FetchTextFn,
): Promise<CheckResult> {
  const { url, keyword } = parseWatcherSpec(spec);
  const { text, finalUrl } = await fetchText(url);

  if (kind === "web_keyword" || keyword) {
    const present = keyword ? text.includes(keyword) : text.trim().length > 0;
    const state = present ? "present" : "absent";
    const changed = previousState !== "present" && present;
    return {
      state,
      changed,
      detail: changed ? `检测到关键词「${keyword ?? ""}」：${finalUrl}` : undefined,
    };
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  const state = fingerprint(normalized);
  const changed = previousState !== null && previousState !== state;
  return { state, changed, detail: changed ? `页面内容已变化：${finalUrl}` : undefined };
}

export type WatcherChangeHandler = (watcher: Watcher, detail: string | undefined) => Promise<void> | void;

export interface RunWatchersOptions {
  now?: number;
  fetchText?: FetchTextFn;
  onError?: (watcher: Watcher, err: unknown) => void;
}

/**
 * Check every watcher whose interval has elapsed. Successful checks record the
 * new state; failed checks only advance the check time so a broken URL is
 * retried on the next interval rather than every tick.
 */
export async function runWatchers(handler: WatcherChangeHandler, options: RunWatchersOptions = {}): Promise<number> {
  const now = options.now ?? Date.now();
  const fetchText = options.fetchText ?? defaultFetchText;
  const onError =
    options.onError ?? ((watcher, err) => logger.warn(`watchers: ${watcher.id} check failed: ${String(err)}`));
  const due = listWatchersToCheck(now);
  let fired = 0;

  for (const watcher of due) {
    try {
      const result = await checkWatcher(watcher.kind, watcher.spec, watcher.state, fetchText);
      recordWatcherCheck(watcher.id, result.state, now);
      if (result.changed) {
        await handler(watcher, result.detail);
        fired += 1;
      }
    } catch (err) {
      onError(watcher, err);
      touchWatcherCheck(watcher.id, now);
    }
  }
  return fired;
}
