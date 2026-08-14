// Adapted from Tencent/openclaw-weixin (MIT License). See docs/THIRD_PARTY_NOTICES.md.
import { randomUUID } from "node:crypto";

import { apiGetFetch, apiPostFetch } from "./api.js";
import { listIndexedWeixinAccountIds, loadWeixinAccount } from "./accounts.js";
import { logger } from "../logger.js";
import { redactToken } from "../redact.js";

type ActiveLogin = {
  sessionKey: string;
  id: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  botToken?: string;
  status?:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  error?: string;
  currentApiBaseUrl?: string;
  pendingVerifyCode?: string;
};

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

async function readVerifyCodeFromStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk: Buffer | string) => {
      const str = chunk.toString();
      input += str;
      if (input.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(input.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
  });
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

export type WeixinQrStartResult = {
  qrcodeUrl?: string;
  message: string;
  sessionKey: string;
};

export type WeixinQrWaitResult = {
  connected: boolean;
  alreadyConnected?: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
};

export async function startWeixinLoginWithQr(opts: {
  accountId?: string;
  apiBaseUrl: string;
  botType?: string;
  force?: boolean;
}): Promise<WeixinQrStartResult> {
  const sessionKey = opts.accountId || randomUUID();
  purgeExpiredLogins();

  const existing = activeLogins.get(sessionKey);
  if (!opts.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return { qrcodeUrl: existing.qrcodeUrl, message: "二维码已显示，请用手机微信扫描。", sessionKey };
  }

  try {
    const botType = opts.botType || DEFAULT_ILINK_BOT_TYPE;
    const qrResponse = await fetchQRCode(FIXED_BASE_URL, botType);
    logger.info(`QR code received, qrcode=${redactToken(qrResponse.qrcode)}`);

    const login: ActiveLogin = {
      sessionKey,
      id: randomUUID(),
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
    };
    activeLogins.set(sessionKey, login);

    return { qrcodeUrl: qrResponse.qrcode_img_content, message: "用手机微信扫描二维码以继续连接。", sessionKey };
  } catch (err) {
    logger.error(`Failed to start Weixin login: ${String(err)}`);
    return { message: `Failed to start login: ${String(err)}`, sessionKey };
  }
}

async function refreshQRCode(
  activeLogin: ActiveLogin,
  botType: string,
  qrRefreshCount: number,
): Promise<{ success: true } | { success: false; message: string }> {
  process.stdout.write(`\n⏳ 正在刷新二维码...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
  try {
    const qrResponse = await fetchQRCode(FIXED_BASE_URL, botType);
    activeLogin.qrcode = qrResponse.qrcode;
    activeLogin.qrcodeUrl = qrResponse.qrcode_img_content;
    activeLogin.startedAt = Date.now();
    await displayQRCode(qrResponse.qrcode_img_content);
    return { success: true };
  } catch (refreshErr) {
    return { success: false, message: `刷新二维码失败: ${String(refreshErr)}` };
  }
}

export async function waitForWeixinLogin(opts: {
  timeoutMs?: number;
  sessionKey: string;
  apiBaseUrl: string;
  botType?: string;
}): Promise<WeixinQrWaitResult> {
  const activeLogin = activeLogins.get(opts.sessionKey);

  if (!activeLogin) {
    return { connected: false, message: "当前没有进行中的登录，请先发起登录。" };
  }
  if (!isLoginFresh(activeLogin)) {
    activeLogins.delete(opts.sessionKey);
    return { connected: false, message: "二维码已过期，请重新生成。" };
  }

  const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1000);
  const deadline = Date.now() + timeoutMs;
  let scannedPrinted = false;
  let qrRefreshCount = 1;
  activeLogin.currentApiBaseUrl = FIXED_BASE_URL;

  while (Date.now() < deadline) {
    try {
      const currentBaseUrl = activeLogin.currentApiBaseUrl ?? FIXED_BASE_URL;
      const statusResponse = await pollQRStatus(currentBaseUrl, activeLogin.qrcode, activeLogin.pendingVerifyCode);
      activeLogin.status = statusResponse.status;

      switch (statusResponse.status) {
        case "wait":
          break;
        case "scaned":
          if (activeLogin.pendingVerifyCode) {
            activeLogin.pendingVerifyCode = undefined;
          }
          if (!scannedPrinted) {
            process.stdout.write("\n正在验证\n");
            scannedPrinted = true;
          }
          break;
        case "need_verifycode": {
          const verifyPrompt = activeLogin.pendingVerifyCode
            ? "❌ 数字不匹配，请重新输入："
            : "输入手机微信显示的数字，以继续连接：";
          const code = await readVerifyCodeFromStdin(verifyPrompt);
          activeLogin.pendingVerifyCode = code;
          continue;
        }
        case "expired": {
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            activeLogins.delete(opts.sessionKey);
            return { connected: false, message: "二维码多次失效，连接流程已停止。" };
          }
          const result = await refreshQRCode(activeLogin, opts.botType || DEFAULT_ILINK_BOT_TYPE, qrRefreshCount);
          if (!result.success) {
            activeLogins.delete(opts.sessionKey);
            return { connected: false, message: result.message };
          }
          scannedPrinted = false;
          break;
        }
        case "verify_code_blocked": {
          activeLogin.pendingVerifyCode = undefined;
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            activeLogins.delete(opts.sessionKey);
            return { connected: false, message: "多次输入错误，连接流程已停止。" };
          }
          const result = await refreshQRCode(activeLogin, opts.botType || DEFAULT_ILINK_BOT_TYPE, qrRefreshCount);
          if (!result.success) {
            activeLogins.delete(opts.sessionKey);
            return { connected: false, message: result.message };
          }
          scannedPrinted = false;
          break;
        }
        case "binded_redirect": {
          activeLogins.delete(opts.sessionKey);
          return { connected: false, alreadyConnected: true, message: "已连接过此实例，无需重复连接。" };
        }
        case "scaned_but_redirect": {
          const redirectHost = statusResponse.redirect_host;
          if (redirectHost) {
            activeLogin.currentApiBaseUrl = `https://${redirectHost}`;
            logger.info(`IDC redirect, switching polling host to ${redirectHost}`);
          }
          break;
        }
        case "confirmed": {
          if (!statusResponse.ilink_bot_id) {
            activeLogins.delete(opts.sessionKey);
            return { connected: false, message: "登录失败：服务器未返回 ilink_bot_id。" };
          }
          activeLogin.botToken = statusResponse.bot_token;
          activeLogins.delete(opts.sessionKey);
          logger.info(`Login confirmed: ilink_bot_id=${statusResponse.ilink_bot_id}`);
          return {
            connected: true,
            botToken: statusResponse.bot_token,
            accountId: statusResponse.ilink_bot_id,
            baseUrl: statusResponse.baseurl,
            userId: statusResponse.ilink_user_id,
            message: "已将此实例连接到微信。",
          };
        }
      }
    } catch (err) {
      activeLogins.delete(opts.sessionKey);
      return { connected: false, message: `Login failed: ${String(err)}` };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  activeLogins.delete(opts.sessionKey);
  return { connected: false, message: "登录超时，请重试。" };
}
