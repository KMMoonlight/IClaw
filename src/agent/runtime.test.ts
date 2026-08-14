import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { trimMessages, TRANSCRIPT_MAX_MESSAGES } from "./runtime.js";

type MsgRole = "user" | "assistant" | "toolResult";

function msg(role: MsgRole, id: string): AgentMessage {
  return { role, content: [{ type: "text", text: id }] } as unknown as AgentMessage;
}

function idOf(m: AgentMessage): string {
  const content = (m as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? "";
}

describe("trimMessages", () => {
  it("returns the same array when under the limit", () => {
    const msgs = [msg("user", "1"), msg("assistant", "2")];
    expect(trimMessages(msgs, 10)).toBe(msgs);
  });

  it("cuts at the next user-message boundary", () => {
    const msgs = [
      msg("user", "1"),
      msg("assistant", "2"),
      msg("user", "3"),
      msg("assistant", "4"),
      msg("toolResult", "5"),
    ];
    const out = trimMessages(msgs, 3);
    expect(out.map(idOf)).toEqual(["3", "4", "5"]);
  });

  it("falls back to a plain slice when the tail has no user message", () => {
    const msgs = [msg("assistant", "1"), msg("toolResult", "2"), msg("toolResult", "3")];
    const out = trimMessages(msgs, 2);
    expect(out).toHaveLength(2);
    expect(out.map(idOf)).toEqual(["2", "3"]);
  });

  it("never starts with an orphaned tool result when a boundary exists", () => {
    const msgs = [msg("user", "1"), msg("assistant", "2"), msg("toolResult", "3"), msg("user", "4")];
    const out = trimMessages(msgs, 2);
    expect(out[0]?.role).toBe("user");
  });

  it("ships a sane production cap", () => {
    expect(TRANSCRIPT_MAX_MESSAGES).toBeGreaterThanOrEqual(50);
  });
});
