import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const { estimateContextTokens, estimateTokens, generateSummary, shouldCompact } = vi.hoisted(() => ({
  estimateContextTokens: vi.fn(),
  estimateTokens: vi.fn(),
  generateSummary: vi.fn(),
  shouldCompact: vi.fn(),
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return {
    ...actual,
    DEFAULT_COMPACTION_SETTINGS: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    estimateContextTokens,
    estimateTokens,
    generateSummary,
    shouldCompact,
  };
});

vi.mock("./models.js", () => ({
  getModels: () => ({}),
  resolveConfiguredModel: () => ({ id: "test-model" }),
}));

import { maybeCompactTranscript, trimMessages, TRANSCRIPT_MAX_MESSAGES } from "./transcript.js";

function msg(role: "user" | "assistant" | "toolResult", id: string): AgentMessage {
  return { role, content: [{ type: "text", text: id }] } as unknown as AgentMessage;
}

function idOf(m: AgentMessage): string {
  const content = (m as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? "";
}

function fakeAgent(messages: AgentMessage[]) {
  return {
    state: { messages },
  } as unknown as Parameters<typeof maybeCompactTranscript>[0];
}

beforeEach(() => {
  estimateContextTokens.mockReset();
  estimateTokens.mockReset();
  generateSummary.mockReset();
  shouldCompact.mockReset();
});

describe("trimMessages", () => {
  it("returns the same array when under the limit", () => {
    const msgs = [msg("user", "1"), msg("assistant", "2")];
    expect(trimMessages(msgs, 10)).toBe(msgs);
  });

  it("cuts at the next user-message boundary", () => {
    const msgs = [msg("user", "1"), msg("assistant", "2"), msg("user", "3"), msg("assistant", "4"), msg("toolResult", "5")];
    const out = trimMessages(msgs, 3);
    expect(out.map(idOf)).toEqual(["3", "4", "5"]);
  });

  it("never starts with an orphaned tool result when a boundary exists", () => {
    const msgs = [msg("user", "1"), msg("assistant", "2"), msg("toolResult", "3"), msg("user", "4")];
    const out = trimMessages(msgs, 2);
    expect(out[0]?.role).toBe("user");
  });

  it("ships a sane production cap", () => {
    expect(TRANSCRIPT_MAX_MESSAGES).toBeGreaterThanOrEqual(100);
  });
});

describe("maybeCompactTranscript", () => {
  it("does nothing under the token threshold", async () => {
    const agent = fakeAgent([msg("user", "1"), msg("assistant", "2")]);
    estimateContextTokens.mockReturnValue({ tokens: 1000 });
    shouldCompact.mockReturnValue(false);

    const compacted = await maybeCompactTranscript(agent);
    expect(compacted).toBe(false);
    expect(generateSummary).not.toHaveBeenCalled();
    expect(agent.state.messages).toHaveLength(2);
  });

  it("summarizes the old part and keeps the recent tail", async () => {
    const msgs = [
      msg("user", "old-1"),
      msg("assistant", "old-2"),
      msg("user", "new-1"),
      msg("assistant", "new-2"),
    ];
    const agent = fakeAgent([...msgs]);
    estimateContextTokens.mockReturnValue({ tokens: 200_000 });
    shouldCompact.mockReturnValue(true);
    estimateTokens.mockReturnValue(10000); // two tail messages reach keepRecentTokens(20000) -> cut at new-1
    generateSummary.mockResolvedValue({ ok: true, value: "OLD SUMMARY" });

    const compacted = await maybeCompactTranscript(agent);
    expect(compacted).toBe(true);
    expect(generateSummary).toHaveBeenCalledWith(
      [msgs[0], msgs[1]],
      expect.anything(),
      expect.anything(),
      expect.any(Number),
    );
    expect(agent.state.messages).toHaveLength(3);
    expect(idOf(agent.state.messages[0]!)).toContain("OLD SUMMARY");
    expect(agent.state.messages[0]?.role).toBe("user");
    expect(agent.state.messages.map(idOf).slice(1)).toEqual(["new-1", "new-2"]);
  });

  it("falls back to keeping only the tail when summarization fails", async () => {
    const msgs = [msg("user", "old-1"), msg("assistant", "old-2"), msg("user", "new-1")];
    const agent = fakeAgent([...msgs]);
    estimateContextTokens.mockReturnValue({ tokens: 200_000 });
    shouldCompact.mockReturnValue(true);
    estimateTokens.mockReturnValue(10000); // trailing new-1 alone < keepRecentTokens -> snap to cut at new-1
    generateSummary.mockRejectedValue(new Error("model down"));

    const compacted = await maybeCompactTranscript(agent);
    expect(compacted).toBe(true);
    expect(agent.state.messages.map(idOf)).toEqual(["new-1"]);
  });

  it("does nothing when the cut would drop everything", async () => {
    const agent = fakeAgent([msg("user", "only")]);
    estimateContextTokens.mockReturnValue({ tokens: 200_000 });
    shouldCompact.mockReturnValue(true);
    estimateTokens.mockReturnValue(20000); // cut at index 0 -> snaps to 0

    expect(await maybeCompactTranscript(agent)).toBe(false);
    expect(generateSummary).not.toHaveBeenCalled();
  });
});
