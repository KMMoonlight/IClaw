import { getConfig, sendTyping } from "./api.js";
import { logger } from "../logger.js";
import { TypingStatus } from "./types.js";

/**
 * "对方正在输入…" 指示。
 * 上游同款做法：getconfig 取 typing_ticket（按用户缓存，24h 内随机刷新，
 * 失败指数退避），agent 生成期间 sendtyping(TYPING) 并每 5s 心跳，
 * 结束后 sendtyping(CANCEL)。任何失败只降级为"不显示指示"，绝不阻塞回复。
 */

const CONFIG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIG_CACHE_INITIAL_RETRY_MS = 2_000;
const CONFIG_CACHE_MAX_RETRY_MS = 60 * 60 * 1000;
const KEEPALIVE_INTERVAL_MS = 5_000;

interface TicketCacheEntry {
  ticket: string;
  nextFetchAt: number;
  retryDelayMs: number;
}

const ticketCache = new Map<string, TicketCacheEntry>();

export async function resolveTypingTicket(opts: {
  baseUrl: string;
  token?: string;
  wechatUserId: string;
  contextToken?: string;
}): Promise<string> {
  const now = Date.now();
  const key = opts.wechatUserId;
  const entry = ticketCache.get(key);
  if (entry && now < entry.nextFetchAt) return entry.ticket;

  try {
    const resp = await getConfig({
      baseUrl: opts.baseUrl,
      token: opts.token,
      ilinkUserId: opts.wechatUserId,
      contextToken: opts.contextToken,
    });
    if (resp.ret === 0) {
      const ticket = resp.typing_ticket ?? "";
      ticketCache.set(key, {
        ticket,
        nextFetchAt: now + Math.random() * CONFIG_CACHE_TTL_MS,
        retryDelayMs: CONFIG_CACHE_INITIAL_RETRY_MS,
      });
      return ticket;
    }
  } catch (err) {
    logger.debug(`typing: getConfig failed for ${key} (ignored): ${String(err)}`);
  }

  const delay = Math.min((entry?.retryDelayMs ?? CONFIG_CACHE_INITIAL_RETRY_MS) * 2, CONFIG_CACHE_MAX_RETRY_MS);
  ticketCache.set(key, {
    ticket: entry?.ticket ?? "",
    nextFetchAt: now + delay,
    retryDelayMs: delay,
  });
  return entry?.ticket ?? "";
}

export async function sendTypingIndicator(opts: {
  baseUrl: string;
  token?: string;
  wechatUserId: string;
  typingTicket: string;
  status: number;
}): Promise<void> {
  try {
    await sendTyping({
      baseUrl: opts.baseUrl,
      token: opts.token,
      body: {
        ilink_user_id: opts.wechatUserId,
        typing_ticket: opts.typingTicket,
        status: opts.status,
      },
    });
  } catch (err) {
    logger.debug(`typing: sendtyping failed (ignored): ${String(err)}`);
  }
}

/** One typing session around a single agent turn. */
export class TypingSession {
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private ticket = "";

  constructor(
    private opts: {
      baseUrl: string;
      token?: string;
      wechatUserId: string;
      contextToken?: string;
    },
  ) {}

  async start(): Promise<void> {
    const ticket = await resolveTypingTicket({
      baseUrl: this.opts.baseUrl,
      token: this.opts.token,
      wechatUserId: this.opts.wechatUserId,
      contextToken: this.opts.contextToken,
    });
    if (!ticket) return; // no ticket -> typing indicator unsupported; degrade silently
    this.ticket = ticket;
    await sendTypingIndicator({
      baseUrl: this.opts.baseUrl,
      token: this.opts.token,
      wechatUserId: this.opts.wechatUserId,
      typingTicket: ticket,
      status: TypingStatus.TYPING,
    });
    if (this.stopped) return;
    this.timer = setInterval(() => {
      void sendTypingIndicator({
        baseUrl: this.opts.baseUrl,
        token: this.opts.token,
        wechatUserId: this.opts.wechatUserId,
        typingTicket: this.ticket,
        status: TypingStatus.TYPING,
      });
    }, KEEPALIVE_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.ticket) {
      await sendTypingIndicator({
        baseUrl: this.opts.baseUrl,
        token: this.opts.token,
        wechatUserId: this.opts.wechatUserId,
        typingTicket: this.ticket,
        status: TypingStatus.CANCEL,
      });
    }
  }
}
