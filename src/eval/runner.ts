import type { EvalCase, EvalCaseResult, EvalSummary } from "./types.js";

/** Run a set of eval cases sequentially, capturing pass/fail per case. */
export async function runEvalSuite(cases: EvalCase[]): Promise<EvalSummary> {
  const results: EvalCaseResult[] = [];
  for (const testCase of cases) {
    const start = Date.now();
    try {
      await testCase.run();
      results.push({
        name: testCase.name,
        group: testCase.group ?? "default",
        passed: true,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        name: testCase.name,
        group: testCase.group ?? "default",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
  }
  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

/** Human-readable report, grouped by category. */
export function formatEvalReport(summary: EvalSummary): string {
  const lines: string[] = [];
  const groups = new Map<string, EvalCaseResult[]>();
  for (const result of summary.results) {
    const list = groups.get(result.group) ?? [];
    list.push(result);
    groups.set(result.group, list);
  }
  for (const [group, results] of groups) {
    lines.push(`\n## ${group}`);
    for (const r of results) {
      lines.push(`  ${r.passed ? "✓" : "✗"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
    }
  }
  lines.push(`\n结果：${summary.passed}/${summary.total} 通过，${summary.failed} 失败`);
  return lines.join("\n");
}
