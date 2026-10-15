import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { hasUsage, lastAssistantUsage } from "./usage.js";

function assistant(usage?: unknown): AgentMessage {
  return { role: "assistant", content: [], usage } as unknown as AgentMessage;
}
function user(): AgentMessage {
  return { role: "user", content: [{ type: "text", text: "hi" }] } as unknown as AgentMessage;
}

const usage = { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, totalTokens: 127, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 } };

describe("lastAssistantUsage", () => {
  it("returns null when there is no assistant usage", () => {
    expect(lastAssistantUsage([])).toBeNull();
    expect(lastAssistantUsage([user(), assistant()])).toBeNull();
  });

  it("maps the most recent assistant usage", () => {
    const result = lastAssistantUsage([assistant(usage), user(), assistant()]);
    expect(result).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 2, costTotal: 0.05 });
  });

  it("picks the latest assistant message that has usage", () => {
    const older = { ...usage, input: 1, cost: { ...usage.cost, total: 0.01 } };
    const newer = { ...usage, input: 999, cost: { ...usage.cost, total: 0.09 } };
    expect(lastAssistantUsage([assistant(older), assistant(newer)])!.input).toBe(999);
    expect(lastAssistantUsage([assistant(older), assistant(newer)])!.costTotal).toBe(0.09);
  });
});

describe("hasUsage", () => {
  it("is false for all-zero usage", () => {
    expect(hasUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 })).toBe(false);
  });
  it("is true when any token or cost is non-zero", () => {
    expect(hasUsage({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 })).toBe(true);
    expect(hasUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0.001 })).toBe(true);
  });
});
