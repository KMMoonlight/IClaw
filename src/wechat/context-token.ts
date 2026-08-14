// Adapted from Tencent/openclaw-weixin (MIT License). See docs/THIRD_PARTY_NOTICES.md.
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config.js";
import { logger } from "../logger.js";

/**
 * contextToken is issued per-message by getupdates and must be echoed verbatim
 * in every outbound send. In-memory map + disk persistence (survives restart).
 */
const contextTokenStore = new Map<string, string>();

function key(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

function filePath(accountId: string): string {
  return path.join(resolveStateDir(), "wechat", "accounts", `${accountId}.context-tokens.json`);
}

function persist(accountId: string): void {
  const prefix = `${accountId}:`;
  const tokens: Record<string, string> = {};
  for (const [k, v] of contextTokenStore) {
    if (k.startsWith(prefix)) tokens[k.slice(prefix.length)] = v;
  }
  const fp = filePath(accountId);
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(tokens), "utf-8");
  } catch (err) {
    logger.warn(`persistContextTokens: ${String(err)}`);
  }
}

export function restoreContextTokens(accountId: string): void {
  const fp = filePath(accountId);
  try {
    if (!fs.existsSync(fp)) return;
    const tokens = JSON.parse(fs.readFileSync(fp, "utf-8")) as Record<string, string>;
    for (const [userId, token] of Object.entries(tokens)) {
      if (typeof token === "string" && token) contextTokenStore.set(key(accountId, userId), token);
    }
  } catch (err) {
    logger.warn(`restoreContextTokens: ${String(err)}`);
  }
}

export function clearContextTokensForAccount(accountId: string): void {
  const prefix = `${accountId}:`;
  for (const k of [...contextTokenStore.keys()]) {
    if (k.startsWith(prefix)) contextTokenStore.delete(k);
  }
  const fp = filePath(accountId);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {
    // ignore
  }
}

export function setContextToken(accountId: string, userId: string, token: string): void {
  contextTokenStore.set(key(accountId, userId), token);
  persist(accountId);
}

export function getContextToken(accountId: string, userId: string): string | undefined {
  return contextTokenStore.get(key(accountId, userId));
}
