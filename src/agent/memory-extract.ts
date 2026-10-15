import { contentText } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { loadConfig } from "../config.js";
import { addMemory, findMemoryByContent, listMemories } from "../db/index.js";
import { logger } from "../logger.js";
import { getModels, resolveConfiguredModel } from "./models.js";

/** Allowed kinds; anything else the model returns is coerced to "fact". */
const MEMORY_KINDS = new Set<string>(["fact", "preference", "event", "profile"]);
const EXTRACTION_MAX_TOKENS = 1024;
/** Never store more than this many new memories from a single turn. */
export const MAX_EXTRACTED_PER_TURN = 10;

export interface ExtractedMemory {
  content: string;
  kind: string;
  importance: number;
}

export const EXTRACTION_SYSTEM_PROMPT = [
  "你是一个记忆抽取器，从用户与助手的对话中提取值得长期记住的关于「用户」的信息。",
  "只提取稳定、有长期价值的信息（如身份、偏好、习惯、重要事实、正在进行的长期事项）。",
  "不要提取一次性寒暄、临时任务、助手自己说的话，也不要提取已有记忆的重复内容。",
  "只输出一个 JSON 数组，不要输出任何解释。数组元素形如：",
  '{"content": "用户喜欢喝美式咖啡", "kind": "preference", "importance": 0.7}',
  'kind 只能是 fact / preference / event / profile 之一；importance 是 0-1 的数字。',
  "如果没有值得记住的信息，输出 []。",
].join("\n");

/** Render the tail of an agent transcript into a compact role-tagged transcript. */
export function serializeMessages(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      const text = contentText((m as { content?: Parameters<typeof contentText>[0] }).content ?? "").trim();
      if (!text) return null;
      const role = m.role === "assistant" ? "助手" : m.role === "user" ? "用户" : String(m.role);
      return `${role}：${text}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildExtractionPrompt(conversationText: string, existing: string[]): string {
  const existingBlock = existing.length
    ? `<already-known>\n${existing.map((e) => `- ${e}`).join("\n")}\n</already-known>\n\n`
    : "";
  return `${existingBlock}<conversation>\n${conversationText}\n</conversation>\n\n请输出需要新记住的信息的 JSON 数组。`;
}

/**
 * Parse the model's extraction response. Tolerant of code fences, surrounding
 * prose, plain-string arrays, and invalid fields.
 */
export function parseExtractedMemories(raw: string): ExtractedMemory[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedMemory[] = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      const content = item.trim();
      if (content) out.push({ content, kind: "fact", importance: 0.5 });
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const content = String(record.content ?? record.fact ?? "").trim();
      if (!content) continue;
      const kindRaw = String(record.kind ?? "fact").trim().toLowerCase();
      const kind = MEMORY_KINDS.has(kindRaw) ? kindRaw : "fact";
      const rawImportance = Number(record.importance);
      const importance = Number.isFinite(rawImportance) ? Math.min(1, Math.max(0, rawImportance)) : 0.5;
      out.push({ content, kind, importance });
    }
    if (out.length >= MAX_EXTRACTED_PER_TURN) break;
  }
  return out;
}

/** Drop items already known (case-insensitive) or duplicated within the response. */
export function dedupeExtracted(items: ExtractedMemory[], existing: string[]): ExtractedMemory[] {
  const seen = new Set(existing.map((e) => e.trim().toLowerCase()));
  const out: ExtractedMemory[] = [];
  for (const item of items) {
    const key = item.content.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** A single-turn text completion, injected so extraction is testable without a model. */
export type CompleteFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** Build a completer backed by the globally configured model. */
export function modelCompleter(): CompleteFn {
  const models = getModels();
  const model: Model<any> = resolveConfiguredModel();
  return async (systemPrompt, userPrompt) => {
    const response = await models.completeSimple(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
      },
      { maxTokens: EXTRACTION_MAX_TOKENS },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || `model stopped: ${response.stopReason}`);
    }
    return contentText(response.content);
  };
}

/** Extract candidate memories from a conversation tail (no persistence). */
export async function extractMemoriesFromConversation(
  messages: AgentMessage[],
  existing: string[],
  complete: CompleteFn,
): Promise<ExtractedMemory[]> {
  const conversationText = serializeMessages(messages);
  if (!conversationText.trim()) return [];
  const raw = await complete(EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt(conversationText, existing));
  return dedupeExtracted(parseExtractedMemories(raw), existing);
}

/** Persist extracted memories, skipping anything already stored. Returns the count added. */
export function persistExtractedMemories(userId: string, items: ExtractedMemory[]): number {
  let added = 0;
  for (const item of items) {
    if (findMemoryByContent(userId, item.content)) continue;
    addMemory(userId, item.content, { kind: item.kind, source: "auto", importance: item.importance });
    added += 1;
  }
  return added;
}

/**
 * Top-level hook called after a turn. No-op unless ICLAW_MEMORY_AUTO_EXTRACT is
 * enabled; never throws (failures are logged and swallowed).
 */
export async function extractAndRememberMemories(userId: string, messages: AgentMessage[]): Promise<number> {
  if (!loadConfig().memoryAutoExtract) return 0;
  try {
    const existing = listMemories(userId).map((m) => m.content);
    const items = await extractMemoriesFromConversation(messages, existing, modelCompleter());
    const added = persistExtractedMemories(userId, items);
    if (added > 0) logger.info(`memory: auto-extracted ${added} entr(ies) for ${userId}`);
    return added;
  } catch (err) {
    logger.warn(`memory: auto-extraction failed for ${userId}: ${String(err)}`);
    return 0;
  }
}
