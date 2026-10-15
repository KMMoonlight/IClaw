import { loadConfig } from "../config.js";
import { getUserUsageForDay } from "../db/index.js";

/** Sliding window of recent inbound message timestamps per user. */
const messageTimes = new Map<string, number[]>();
const WINDOW_MS = 60_000;

export interface QuotaDecision {
  allowed: boolean;
  reason?: string;
}

/** Record an inbound message for the per-minute rate limit. */
export function noteInboundMessage(userId: string, now = Date.now()): void {
  const times = (messageTimes.get(userId) ?? []).filter((t) => t >= now - WINDOW_MS);
  times.push(now);
  messageTimes.set(userId, times);
}

/**
 * Check a user's quota: per-minute message rate and daily token budget.
 * Both limits are opt-in (0 = unlimited).
 */
export function checkQuota(userId: string, now = Date.now()): QuotaDecision {
  const cfg = loadConfig();

  if (cfg.userRatePerMin > 0) {
    const times = (messageTimes.get(userId) ?? []).filter((t) => t >= now - WINDOW_MS);
    if (times.length >= cfg.userRatePerMin) {
      return { allowed: false, reason: `请求过于频繁（每分钟最多 ${cfg.userRatePerMin} 条），请稍后再试。` };
    }
  }

  if (cfg.userDailyTokenLimit > 0) {
    const usage = getUserUsageForDay(userId);
    if (usage.input + usage.output >= cfg.userDailyTokenLimit) {
      return { allowed: false, reason: `今日额度已用完（token 上限 ${cfg.userDailyTokenLimit}），请明天再试。` };
    }
  }

  return { allowed: true };
}

/** Clear rate-limit state (tests / restarts). */
export function resetQuotaState(): void {
  messageTimes.clear();
}
