import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  generateSummary,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";

import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { getModels, resolveConfiguredModel } from "./models.js";

/**
 * Hard safety cap: even without token pressure we never persist more than this
 * many messages per user. Real context management is token-aware (see
 * maybeCompactTranscript below); this is only the last-resort truncation.
 */
export const TRANSCRIPT_MAX_MESSAGES = 400;

/**
 * Trim the transcript to at most `max` messages, cutting at a user-message
 * boundary so the remaining tail stays structurally valid for the model
 * (never starts with an orphaned tool result).
 */
export function trimMessages(msgs: AgentMessage[], max: number): AgentMessage[] {
  if (msgs.length <= max) return msgs;
  let start = msgs.length - max;
  for (let i = start; i < msgs.length; i++) {
    if (msgs[i]?.role === "user") {
      start = i;
      break;
    }
  }
  return msgs.slice(start);
}

/** Find the boundary for compaction: keep ~keepRecentTokens from the tail, snapped to a user message. */
function findCompactionCut(messages: AgentMessage[], keepRecentTokens: number): number {
  let cut = messages.length;
  let trailing = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    trailing += estimateTokens(messages[i]!);
    if (trailing >= keepRecentTokens) {
      cut = i;
      break;
    }
  }
  for (let i = cut; i < messages.length; i++) {
    if (messages[i]?.role === "user") {
      cut = i;
      break;
    }
  }
  return cut;
}

/**
 * Token-aware context compression: when the transcript's estimated tokens
 * exceed `contextWindow - reserveTokens`, summarize the older part with the
 * same model and replace it with a labelled summary message (the same
 * rendering pi's own harness uses), keeping the recent tail intact.
 *
 * Returns true when a compaction ran. Never throws: failures fall back to
 * keeping only the recent tail.
 */
export async function maybeCompactTranscript(agent: Agent): Promise<boolean> {
  const messages = agent.state.messages;
  if (messages.length === 0) return false;

  const { tokens } = estimateContextTokens(messages);
  const cfg = loadConfig();
  if (!shouldCompact(tokens, cfg.modelContextWindow, DEFAULT_COMPACTION_SETTINGS)) {
    return false;
  }

  const cut = findCompactionCut(messages, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);
  if (cut <= 0) return false;
  const old = messages.slice(0, cut);
  const tail = messages.slice(cut);
  if (old.length === 0) return false;

  try {
    const models = getModels();
    const model = resolveConfiguredModel();
    const result = await generateSummary(old, models, model, DEFAULT_COMPACTION_SETTINGS.reserveTokens);
    if (result.ok) {
      const summaryMsg: AgentMessage = {
        role: "user",
        content: [
          {
            type: "text",
            text: `以下内容为此前的对话历史摘要：\n<summary>\n${result.value}\n</summary>`,
          },
        ],
        timestamp: Date.now(),
      };
      agent.state.messages = [summaryMsg, ...tail];
      logger.info(`compaction: summarized ${old.length} messages (est. ${tokens} tokens) into one summary`);
      return true;
    }
    logger.warn(`compaction: summary generation failed (${String(result.error)}); keeping recent tail only`);
  } catch (err) {
    logger.warn(`compaction: summary generation threw (${String(err)}); keeping recent tail only`);
  }
  agent.state.messages = tail;
  return true;
}
