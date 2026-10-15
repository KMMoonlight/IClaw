import { describe, expect, it } from "vitest";

import { formatEvalReport, runEvalSuite } from "./runner.js";
import { deterministicCases } from "./suite.js";

describe("eval runner", () => {
  it("captures passing and failing cases", async () => {
    const summary = await runEvalSuite([
      { name: "ok", group: "g", run: () => {} },
      {
        name: "bad",
        group: "g",
        run: () => {
          throw new Error("boom");
        },
      },
      { name: "async-ok", group: "h", run: async () => {} },
    ]);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    const report = formatEvalReport(summary);
    expect(report).toContain("✓ ok");
    expect(report).toContain("✗ bad — boom");
    expect(report).toContain("2/3 通过");
  });
});

describe("deterministic eval suite", () => {
  it("all cases pass", async () => {
    const summary = await runEvalSuite(deterministicCases());
    const failures = summary.results.filter((r) => !r.passed).map((r) => `${r.name}: ${r.error}`);
    expect(failures.join("\n")).toBe("");
    expect(summary.total).toBeGreaterThan(0);
  });
});
