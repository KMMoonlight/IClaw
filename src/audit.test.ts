import { describe, expect, it } from "vitest";

import { summarizeAuditArgs } from "./audit.js";

describe("summarizeAuditArgs", () => {
  it("serializes args and redacts secrets", () => {
    const summary = summarizeAuditArgs({ command: "echo hi", aeskey: "deadbeef", Authorization: "Bearer secret" });
    expect(summary).toContain("echo hi");
    expect(summary).not.toContain("deadbeef");
    expect(summary).not.toContain("Bearer secret");
  });

  it("truncates long arguments", () => {
    const summary = summarizeAuditArgs({ blob: "x".repeat(1000) }, 50);
    expect(summary.length).toBeLessThanOrEqual(51);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("handles non-serializable input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(summarizeAuditArgs(circular)).toBe("");
  });
});
