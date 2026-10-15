/** Minimal in-process metrics registry with Prometheus text exposition. */

function labelString(labels?: Record<string, string>): string {
  if (!labels) return "";
  const parts = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/(["\\])/g, "\\$1")}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

interface Observation {
  count: number;
  sum: number;
  labels: string;
}

const counters = new Map<string, { value: number; base: string; labels: string }>();
const observations = new Map<string, Observation>();

/** Increment a counter. */
export function inc(name: string, labels?: Record<string, string>, value = 1): void {
  const k = `${name}${labelString(labels)}`;
  const existing = counters.get(k);
  if (existing) existing.value += value;
  else counters.set(k, { value, base: name, labels: labelString(labels) });
}

/** Record an observation (e.g. a duration in seconds) for a summary metric. */
export function observe(name: string, value: number, labels?: Record<string, string>): void {
  const k = `${name}${labelString(labels)}`;
  const existing = observations.get(k);
  if (existing) {
    existing.count += 1;
    existing.sum += value;
  } else {
    observations.set(k, { count: 1, sum: value, labels: labelString(labels) });
  }
}

/** Render all metrics in Prometheus text format. */
export function renderPrometheus(): string {
  const lines: string[] = [];

  const counterBases = new Map<string, Array<{ labels: string; value: number }>>();
  for (const { value, base, labels } of counters.values()) {
    const list = counterBases.get(base) ?? [];
    list.push({ labels, value });
    counterBases.set(base, list);
  }
  for (const [base, samples] of counterBases) {
    lines.push(`# TYPE ${base} counter`);
    for (const s of samples) lines.push(`${base}${s.labels} ${s.value}`);
  }

  const summaryBases = new Map<string, Observation[]>();
  for (const [key, obs] of observations) {
    const base = key.replace(/\{.*$/, "");
    const list = summaryBases.get(base) ?? [];
    list.push(obs);
    summaryBases.set(base, list);
  }
  for (const [base, samples] of summaryBases) {
    lines.push(`# TYPE ${base} summary`);
    for (const s of samples) {
      lines.push(`${base}_count${s.labels} ${s.count}`);
      lines.push(`${base}_sum${s.labels} ${s.sum}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Clear all metrics (tests). */
export function resetMetrics(): void {
  counters.clear();
  observations.clear();
}
