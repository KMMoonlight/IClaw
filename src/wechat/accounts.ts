// Adapted from Tencent/openclaw-weixin (MIT License). See docs/THIRD_PARTY_NOTICES.md.
import fs from "node:fs";
import path from "node:path";

import { CDN_BASE_URL, DEFAULT_BASE_URL, resolveStateDir } from "../config.js";
import { logger } from "../logger.js";

/** Account ids may contain "@" (e.g. "b0f5860fdecb@im.bot"); make them fs-safe. */
export function normalizeAccountId(raw: string): string {
  return raw.trim().replace(/@/g, "-");
}

function resolveWechatStateDir(): string {
  return path.join(resolveStateDir(), "wechat");
}

function resolveAccountsDir(): string {
  return path.join(resolveWechatStateDir(), "accounts");
}

function resolveAccountIndexPath(): string {
  return path.join(resolveWechatStateDir(), "accounts.json");
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

export type WeixinAccountData = {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  /** Weixin user id (the bot's own account owner) from QR login. */
  userId?: string;
};

// ---------------------------------------------------------------------------
// Account index
// ---------------------------------------------------------------------------

export function listIndexedWeixinAccountIds(): string[] {
  try {
    if (!fs.existsSync(resolveAccountIndexPath())) return [];
    const parsed = JSON.parse(fs.readFileSync(resolveAccountIndexPath(), "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

export function registerWeixinAccountId(accountId: string): void {
  fs.mkdirSync(resolveWechatStateDir(), { recursive: true });
  const existing = listIndexedWeixinAccountIds();
  if (existing.includes(accountId)) return;
  fs.writeFileSync(
    resolveAccountIndexPath(),
    JSON.stringify([...existing, accountId], null, 2),
    "utf-8",
  );
}

export function unregisterWeixinAccountId(accountId: string): void {
  const existing = listIndexedWeixinAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length !== existing.length) {
    fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Account store
// ---------------------------------------------------------------------------

export function loadWeixinAccount(accountId: string): WeixinAccountData | null {
  try {
    const filePath = resolveAccountPath(accountId);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountData;
    }
  } catch {
    // ignore
  }
  return null;
}

export function saveWeixinAccount(
  accountId: string,
  update: { token?: string; baseUrl?: string; userId?: string },
): void {
  fs.mkdirSync(resolveAccountsDir(), { recursive: true });
  const existing = loadWeixinAccount(accountId) ?? {};

  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId =
    update.userId !== undefined ? update.userId.trim() || undefined : existing.userId?.trim() || undefined;

  const data: WeixinAccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };

  const filePath = resolveAccountPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

export function clearWeixinAccount(accountId: string): void {
  const dir = resolveAccountsDir();
  for (const file of [`${accountId}.json`, `${accountId}.sync.json`, `${accountId}.context-tokens.json`]) {
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

export type ResolvedWeixinAccount = {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  configured: boolean;
};

export function resolveWeixinAccount(accountId?: string | null): ResolvedWeixinAccount {
  const raw = accountId?.trim();
  if (!raw) {
    // Single-account convenience: use the only registered account.
    const ids = listIndexedWeixinAccountIds();
    if (ids.length === 1) return resolveWeixinAccount(ids[0]);
    if (ids.length > 1) throw new Error("weixin: multiple accounts registered — specify accountId");
    throw new Error("weixin: no accounts registered — run the login flow first");
  }
  const id = normalizeAccountId(raw);
  const data = loadWeixinAccount(id) ?? {};
  const cfg = { baseUrl: DEFAULT_BASE_URL, cdnBaseUrl: CDN_BASE_URL };
  return {
    accountId: id,
    baseUrl: data.baseUrl?.trim() || cfg.baseUrl,
    cdnBaseUrl: cfg.cdnBaseUrl,
    token: data.token?.trim() || undefined,
    configured: Boolean(data.token?.trim()),
  };
}

export function logAccountState(): void {
  for (const id of listIndexedWeixinAccountIds()) {
    const data = loadWeixinAccount(id);
    logger.info(`account ${id}: configured=${Boolean(data?.token)}`);
  }
}
