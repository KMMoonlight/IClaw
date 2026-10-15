import { loadConfig } from "./config.js";

export interface ModerationResult {
  ok: boolean;
  /** The pattern that matched, when blocked. */
  reason?: string;
}

/**
 * Check outbound text against the configured blocklist (case-insensitive
 * regular expressions). Invalid patterns are ignored.
 */
export function moderateOutbound(text: string): ModerationResult {
  for (const pattern of loadConfig().outboundBlocklist) {
    try {
      if (new RegExp(pattern, "i").test(text)) return { ok: false, reason: pattern };
    } catch {
      // Ignore a malformed pattern rather than breaking the send path.
    }
  }
  return { ok: true };
}

/** Return the text unchanged, or the configured safe message when blocked. */
export function applyOutboundModeration(text: string): string {
  return moderateOutbound(text).ok ? text : loadConfig().outboundBlockMessage;
}
