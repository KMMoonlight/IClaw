/**
 * Minimal, dependency-free 5-field cron support: `minute hour day-of-month month day-of-week`.
 *
 * Supported syntax per field: `*`, a number, `a-b`, `a-b/step`, `*​/step`, and comma lists.
 * Names (`MON`), `?`, `L`, `W`, `#` are intentionally NOT supported.
 * Day-of-week uses 0-6 with 0 = Sunday (7 is accepted as Sunday).
 *
 * Matching semantics follow Vixie cron: when both day-of-month and day-of-week
 * are restricted, a day matches if EITHER matches; otherwise both must match.
 * Evaluation uses the host's local timezone.
 */

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** Whether the day-of-month field was `*`. */
  domWildcard: boolean;
  /** Whether the day-of-week field was `*`. */
  dowWildcard: boolean;
}

/** Parse one cron field into the set of matching values. */
function parseField(raw: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) throw new Error(`cron: empty ${name} segment`);
    const [rangePart, stepPart] = piece.split("/");
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) throw new Error(`cron: bad step "${piece}" in ${name}`);
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart!.includes("-")) {
      const [a, b] = rangePart!.split("-");
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(rangePart);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`cron: bad value "${piece}" in ${name}`);
    if (start < min || end > max || start > end) throw new Error(`cron: out-of-range "${piece}" in ${name}`);
    for (let v = start; v <= end; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`cron: empty ${name}`);
  return out;
}

/** Parse a 5-field cron expression. Throws on malformed input. */
export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron: expected 5 fields, got ${parts.length} ("${expression}")`);
  }
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const dayOfWeek = new Set<number>();
  for (const v of parseField(dow, 0, 7, "day-of-week")) dayOfWeek.add(v === 7 ? 0 : v);
  const dayOfMonthRaw = dom.trim();
  const dowRaw = dow.trim();
  return {
    minute: parseField(minute, 0, 59, "minute"),
    hour: parseField(hour, 0, 23, "hour"),
    dayOfMonth: parseField(dayOfMonthRaw, 1, 31, "day-of-month"),
    month: parseField(month, 1, 12, "month"),
    dayOfWeek,
    domWildcard: dayOfMonthRaw === "*",
    dowWildcard: dowRaw === "*",
  };
}

/** Does `date` match the parsed cron fields? */
export function matchesCron(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes())) return false;
  if (!fields.hour.has(date.getHours())) return false;
  if (!fields.month.has(date.getMonth() + 1)) return false;
  const domMatch = fields.dayOfMonth.has(date.getDate());
  const dowMatch = fields.dayOfWeek.has(date.getDay());
  if (!fields.domWildcard && !fields.dowWildcard) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

const MAX_ITERATIONS = 366 * 24 * 60 * 5; // ~5 years of minutes

/**
 * Compute the next time at or after `from` (exclusive of the current minute)
 * that matches the expression, or null if none is found within ~5 years.
 */
export function nextCronRun(fields: CronFields, from: Date | number): Date | null {
  const start = typeof from === "number" ? new Date(from) : new Date(from.getTime());
  // Advance to the next whole minute.
  start.setSeconds(0, 0);
  start.setTime(start.getTime() + 60_000);

  const cursor = new Date(start.getTime());
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (!fields.month.has(cursor.getMonth() + 1)) {
      // Jump to the first minute of the next month.
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const domMatch = fields.dayOfMonth.has(cursor.getDate());
    const dowMatch = fields.dayOfWeek.has(cursor.getDay());
    const dayMatch = !fields.domWildcard && !fields.dowWildcard ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayMatch) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hour.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fields.minute.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(cursor.getTime());
  }
  return null;
}

/** Convenience: parse + compute in one call. */
export function nextRunForExpression(expression: string, from: Date | number = Date.now()): Date | null {
  return nextCronRun(parseCron(expression), from);
}
