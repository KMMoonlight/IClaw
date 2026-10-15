import { beforeEach, describe, expect, it } from "vitest";

import { inc, observe, renderPrometheus, resetMetrics } from "./metrics.js";

beforeEach(() => resetMetrics());

describe("counters", () => {
  it("accumulates and renders Prometheus counters", () => {
    inc("iclaw_turns_total", { status: "ok" });
    inc("iclaw_turns_total", { status: "ok" });
    inc("iclaw_turns_total", { status: "error" });
    const text = renderPrometheus();
    expect(text).toContain("# TYPE iclaw_turns_total counter");
    expect(text).toContain('iclaw_turns_total{status="ok"} 2');
    expect(text).toContain('iclaw_turns_total{status="error"} 1');
    // Type line appears once.
    expect(text.match(/# TYPE iclaw_turns_total counter/g)).toHaveLength(1);
  });

  it("renders unlabelled counters", () => {
    inc("iclaw_model_fallback_total");
    expect(renderPrometheus()).toContain("iclaw_model_fallback_total 1");
  });

  it("escapes label values", () => {
    inc("iclaw_x_total", { tool: 'a"b\\c' });
    expect(renderPrometheus()).toContain('iclaw_x_total{tool="a\\"b\\\\c"} 1');
  });
});

describe("observations", () => {
  it("renders _count and _sum", () => {
    observe("iclaw_turn_duration_seconds", 0.5);
    observe("iclaw_turn_duration_seconds", 1.5);
    const text = renderPrometheus();
    expect(text).toContain("# TYPE iclaw_turn_duration_seconds summary");
    expect(text).toContain("iclaw_turn_duration_seconds_count 2");
    expect(text).toContain("iclaw_turn_duration_seconds_sum 2");
  });
});

describe("resetMetrics", () => {
  it("clears everything", () => {
    inc("iclaw_y_total");
    resetMetrics();
    expect(renderPrometheus()).not.toContain("iclaw_y_total");
  });
});
