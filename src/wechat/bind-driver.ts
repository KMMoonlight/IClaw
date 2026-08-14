import {
  cancelLoginSession,
  getLoginSession,
  pollLoginSession,
  startLoginSession,
  waitForVerifyCode,
} from "./login-qr.js";
import type { LoginSession } from "./login-qr.js";

export interface BindDriverOptions {
  /** Session key (for Web binding this is `user-<userId>`). */
  key: string;
  /** Called after every state transition (for UI updates). */
  onStateChange?: (session: LoginSession) => void;
  /** Called once the scan is confirmed; persist + bind + start channel here. */
  onConnected?: (session: LoginSession) => Promise<void> | void;
  signal?: AbortSignal;
  /** Delay between gateway polls (each poll itself long-polls up to ~35s). */
  pollIntervalMs?: number;
}

const drivers = new Map<string, AbortController>();

/** Abort the driver running for `key`, if any. */
export function stopBindDriver(key: string): void {
  drivers.get(key)?.abort();
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

/**
 * Drive one QR login session to completion:
 * poll the gateway, pause at need_verifycode until a code is submitted via
 * submitVerifyCode(), auto-refresh expired QR codes, and invoke onConnected
 * when the scan is confirmed. Returns the terminal session state.
 */
export async function runBindSession(opts: BindDriverOptions): Promise<LoginSession> {
  const controller = new AbortController();
  drivers.set(opts.key, controller);
  const aborted = () => opts.signal?.aborted || controller.signal.aborted;

  const failed = (message: string): LoginSession => ({
    key: opts.key,
    phase: "failed",
    message,
    verifyRequired: false,
    connected: false,
    startedAt: Date.now(),
    expiresAt: 0,
  });

  try {
    let session = await startLoginSession({ key: opts.key });
    opts.onStateChange?.(session);
    if (session.phase !== "wait") return session;

    for (;;) {
      if (aborted()) {
        cancelLoginSession(opts.key);
        return { ...failed("已取消。"), phase: "cancelled", message: "已取消。" };
      }
      session = (await pollLoginSession(opts.key)) ?? failed("登录会话已失效，请重新发起。");
      opts.onStateChange?.(session);

      if (session.phase === "need_verifycode") {
        // Pause until a pairing code is submitted (CLI stdin / Web form).
        try {
          await waitForVerifyCode(opts.key);
        } catch {
          continue;
        }
        continue;
      }
      if (session.connected) {
        await opts.onConnected?.(session);
        return session;
      }
      if (session.phase === "failed" || session.phase === "already_connected" || session.phase === "cancelled") {
        return session;
      }
      try {
        await sleep(opts.pollIntervalMs ?? 1000, controller.signal);
      } catch {
        continue; // aborted; loop condition handles it
      }
    }
  } finally {
    drivers.delete(opts.key);
  }
}
