// Adapted from Tencent/openclaw-weixin (MIT License). See docs/THIRD_PARTY_NOTICES.md.
import { randomUUID } from "node:crypto";

import { apiGetFetch, apiPostFetch } from "./api.js";
import { listIndexedWeixinAccountIds, loadWeixinAccount } from "./accounts.js";
import { logger } from "../logger.js";
import { redactToken } from "../redact.js";

export type LoginPhase =
  | "wait"
  | "scanned"
  | "need_verifycode"
  | "expired"
  | "connected"
  | "already_connected"
  | "failed"
  | "cancelled";

/** Observable view of one QR login session (safe to serialize to the Web UI). */
export interface LoginSession {
  key: string;
  /** Internal unique id of this session generation (ownership guard for drivers). */
  id: string;
  phase: LoginPhase;
  message: string;
  /** Content to render as a QR code (the WeChat login link). */
  qrcodeUrl?: string;
  /** True when the scanner must enter the pairing number shown on their phone. */
  verifyRequired: boolean;
  connected: boolean;
  botToken?: string;
  /** Raw ilink_bot_id — the gateway-assigned bot account for the scanning WeChat. */
  accountId?: string;
  baseUrl?: string;
  /** The WeChat user id of the person who scanned (ilink_user_id). */
  wechatUserId?: string;
  startedAt: number;
  expiresAt: number;
}

interface ActiveLogin {
  key: string;
  id: string;
  qrcode: string;
  qrcodeUrl?: string;
  startedAt: number;
  currentApiBaseUrl?: string;
  /** 配对码：用户提交后暂存，下一次轮询时携带。 */
  pendingVerifyCode?: string;
  refreshCount: number;
  phase: LoginPhase;
  message: string;
  connected: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  wechatUserId?: string;
  verifyWaiter?: { resolve: (code: string) => void };
}

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;

export const DEFAULT_ILINK_BOT_TYPE = "3";
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";

const activeLogins = new Map<string, ActiveLogin>();

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function purgeExpiredLogins(): void {
  for (const [id, login] of activeLogins) {
    if (!isLoginFresh(login)) activeLogins.delete(id);
  }
}

function toSession(login: ActiveLogin): LoginSession {
  return {
    key: login.key,
    id: login.id,
    phase: login.phase,
    message: login.message,
    qrcodeUrl: login.qrcodeUrl,
    verifyRequired: login.phase === "need_verifycode",
    connected: login.connected,
    botToken: login.botToken,
    accountId: login.accountId,
    baseUrl: login.baseUrl,
    wechatUserId: login.wechatUserId,
    startedAt: login.startedAt,
    expiresAt: login.startedAt + ACTIVE_LOGIN_TTL_MS,
  };
}

/** 获取本地已登录账号的 bot token 列表，最多返回最新的 10 个。 */
function getLocalBotTokenList(): string[] {
  const accountIds = listIndexedWeixinAccountIds();
  const tokens: string[] = [];
  for (let i = accountIds.length - 1; i >= 0 && tokens.length < 10; i--) {
    const token = loadWeixinAccount(accountIds[i]!)?.token?.trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

async function fetchQRCode(apiBaseUrl: string, botType: string): Promise<QRCodeResponse> {
  const localTokenList = getLocalBotTokenList();
  const rawText = await apiPostFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: JSON.stringify({ local_token_list: localTokenList }),
    label: "fetchQRCode",
  });
  return JSON.parse(rawText) as QRCodeResponse;
}

async function pollQRStatus(
  apiBaseUrl: string,
  qrcode: string,
  verifyCode?: string,
): Promise<StatusResponse> {
  try {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    const rawText = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "pollQRStatus",
    });
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { status: "wait" };
    logger.warn(`pollQRStatus: network/gateway error, will retry: ${String(err)}`);
    return { status: "wait" };
  }
}

export async function displayQRCode(qrcodeUrl: string): Promise<void> {
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(qrcodeUrl, { small: true });
    process.stdout.write(`若二维码未能显示，可访问以下链接：\n${qrcodeUrl}\n`);
  } catch {
    process.stdout.write(`若二维码未能显示，可访问以下链接：\n${qrcodeUrl}\n`);
  }
}

// ---------------------------------------------------------------------------
// Controllable session API（CLI 与 Web 共用）
// ---------------------------------------------------------------------------

export function getLoginSession(key: string): LoginSession | null {
  const login = activeLogins.get(key);
  return login ? toSession(login) : null;
}

/** Create a new QR login session (or return the fresh existing one unless `force`). */
export async function startLoginSession(opts: { key?: string; force?: boolean } = {}): Promise<LoginSession> {
  const key = opts.key ?? randomUUID();
  purgeExpiredLogins();

  const existing = activeLogins.get(key);
  if (!opts.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return toSession(existing);
  }

  try {
    const qrResponse = await fetchQRCode(FIXED_BASE_URL, DEFAULT_ILINK_BOT_TYPE);
    logger.info(`QR code received, qrcode=${redactToken(qrResponse.qrcode)}`);
    const login: ActiveLogin = {
      key,
      id: randomUUID(),
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
      currentApiBaseUrl: FIXED_BASE_URL,
      refreshCount: 0,
      phase: "wait",
      message: "用手机微信扫描二维码以继续连接。",
      connected: false,
    };
    activeLogins.set(key, login);
    return toSession(login);
  } catch (err) {
    logger.error(`Failed to start Weixin login: ${String(err)}`);
    return {
      key,
      id: "",
      phase: "failed",
      message: `Failed to start login: ${String(err)}`,
      verifyRequired: false,
      connected: false,
      startedAt: Date.now(),
      expiresAt: 0,
    };
  }
}

async function refreshQr(login: ActiveLogin): Promise<void> {
  const qrResponse = await fetchQRCode(FIXED_BASE_URL, DEFAULT_ILINK_BOT_TYPE);
  login.qrcode = qrResponse.qrcode;
  login.qrcodeUrl = qrResponse.qrcode_img_content;
  login.startedAt = Date.now();
  login.currentApiBaseUrl = FIXED_BASE_URL;
}

/** Submit the pairing number shown on the scanner's phone. Also unblocks any waiter. */
export function submitVerifyCode(key: string, code: string): void {
  const login = activeLogins.get(key);
  if (!login) return;
  login.pendingVerifyCode = code;
  login.verifyWaiter?.resolve(code);
  login.verifyWaiter = undefined;
}

/** Resolves when a verify code is submitted (used by drivers to pause at need_verifycode). */
export function waitForVerifyCode(key: string): Promise<string> {
  const login = activeLogins.get(key);
  if (!login) return Promise.reject(new Error("login session not found"));
  return new Promise((resolve) => {
    login.verifyWaiter = { resolve };
  });
}

/** Advance the session by exactly one gateway poll. Returns null when the session is gone. */
export async function pollLoginSession(key: string): Promise<LoginSession | null> {
  const login = activeLogins.get(key);
  if (!login) return null;
  if (login.phase === "connected" || login.phase === "failed" || login.phase === "cancelled") {
    return toSession(login);
  }
  if (!isLoginFresh(login)) {
    activeLogins.delete(key);
    return { ...toSession(login), phase: "expired", message: "二维码已过期，请重新发起绑定。" };
  }

  const statusResponse = await pollQRStatus(
    login.currentApiBaseUrl ?? FIXED_BASE_URL,
    login.qrcode,
    login.pendingVerifyCode,
  );

  switch (statusResponse.status) {
    case "wait":
      login.phase = "wait";
      break;
    case "scaned":
      login.pendingVerifyCode = undefined;
      login.phase = "scanned";
      login.message = "已扫码，请在手机上确认授权。";
      break;
    case "need_verifycode": {
      const alreadyTried = Boolean(login.pendingVerifyCode);
      login.pendingVerifyCode = undefined;
      login.phase = "need_verifycode";
      login.message = alreadyTried
        ? "❌ 数字不匹配，请重新输入手机微信上显示的数字。"
        : "请输入手机微信上显示的数字（配对码）。";
      break;
    }
    case "verify_code_blocked":
      login.pendingVerifyCode = undefined;
      login.refreshCount += 1;
      if (login.refreshCount > MAX_QR_REFRESH_COUNT) {
        activeLogins.delete(key);
        return { ...toSession(login), phase: "failed", message: "多次输入错误，连接流程已停止。" };
      }
      await refreshQr(login);
      login.phase = "wait";
      login.message = "验证码多次错误，二维码已刷新，请重新扫码。";
      break;
    case "expired":
      login.refreshCount += 1;
      if (login.refreshCount > MAX_QR_REFRESH_COUNT) {
        activeLogins.delete(key);
        return { ...toSession(login), phase: "failed", message: "二维码多次失效，连接流程已停止。" };
      }
      await refreshQr(login);
      login.phase = "wait";
      login.message = "二维码已过期并自动刷新，请重新扫码。";
      break;
    case "scaned_but_redirect": {
      const redirectHost = statusResponse.redirect_host;
      if (redirectHost) {
        login.currentApiBaseUrl = `https://${redirectHost}`;
        logger.info(`IDC redirect, switching polling host to ${redirectHost}`);
      }
      login.phase = "scanned";
      break;
    }
    case "confirmed": {
      if (!statusResponse.ilink_bot_id) {
        activeLogins.delete(key);
        return { ...toSession(login), phase: "failed", message: "登录失败：服务器未返回 ilink_bot_id。" };
      }
      login.botToken = statusResponse.bot_token;
      login.accountId = statusResponse.ilink_bot_id;
      login.baseUrl = statusResponse.baseurl;
      login.wechatUserId = statusResponse.ilink_user_id;
      login.connected = true;
      login.phase = "connected";
      login.message = "已连接到微信。";
      logger.info(`Login confirmed: ilink_bot_id=${statusResponse.ilink_bot_id}`);
      break;
    }
    case "binded_redirect":
      activeLogins.delete(key);
      return { ...toSession(login), phase: "already_connected", message: "已连接过此实例，无需重复连接。" };
  }
  return toSession(login);
}

/** Cancel a session; unblocks any waiter. */
export function cancelLoginSession(key: string): void {
  const login = activeLogins.get(key);
  if (login) {
    login.verifyWaiter?.resolve("");
    login.verifyWaiter = undefined;
    activeLogins.delete(key);
  }
}

/** Remove a finished session from memory (call after persisting a connected result). */
export function finishLoginSession(key: string): void {
  activeLogins.delete(key);
}
