import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

import type { TokenUsage } from "../db/index.js";

/** Extract provider-reported usage from the most recent assistant message. */
export function lastAssistantUsage(messages: AgentMessage[]): TokenUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; usage?: Usage } | undefined;
    if (message?.role !== "assistant" || !message.usage) continue;
    const u = message.usage;
    return {
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      costTotal: u.cost?.total ?? 0,
    };
  }
  return null;
}

/** Whether a usage record carries any non-zero amount worth storing. */
export function hasUsage(usage: TokenUsage): boolean {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 || usage.costTotal > 0;
}
