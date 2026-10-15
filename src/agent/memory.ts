import type { Memory } from "../db/index.js";

/**
 * Character budget for the memory section injected into the system prompt.
 * Keeps growth from silently bloating every turn's context; T1.3 replaces this
 * with embedding-based relevance selection.
 */
export const MAX_MEMORY_PROMPT_CHARS = 4000;

/** Rank memories for prompt inclusion: importance first, then recency. */
export function rankMemories(memories: Memory[]): Memory[] {
  return [...memories].sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt);
}

/** Select as many top-ranked memories as fit within the character budget (always ≥1). */
export function selectMemoriesForPrompt(memories: Memory[], budget = MAX_MEMORY_PROMPT_CHARS): Memory[] {
  const out: Memory[] = [];
  let used = 0;
  for (const m of rankMemories(memories)) {
    const cost = m.content.length + m.kind.length + 8;
    if (out.length > 0 && used + cost > budget) break;
    out.push(m);
    used += cost;
  }
  return out;
}

/** Render memories as a compact bullet list. */
export function formatMemories(memories: Memory[]): string {
  return memories.map((m) => `- [${m.kind}] ${m.content}`).join("\n");
}

/** Build the "## 关于当前用户的记忆" prompt section, or null when there is nothing to inject. */
export function buildMemorySection(memories: Memory[], budget = MAX_MEMORY_PROMPT_CHARS): string | null {
  if (memories.length === 0) return null;
  const selected = selectMemoriesForPrompt(memories, budget);
  if (selected.length === 0) return null;
  return `## 关于当前用户的记忆\n${formatMemories(selected)}`;
}
