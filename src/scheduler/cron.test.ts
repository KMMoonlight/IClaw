import { describe, expect, it } from "vitest";

import { matchesCron, nextCronRun, nextRunForExpression, parseCron } from "./cron.js";

/** Local-time date helper (cron is evaluated in local time). */
function at(y: number, mo: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

describe("parseCron", () => {
  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * * *")).toThrow("5 fields");
    expect(() => parseCron("60 * * * *")).toThrow("out-of-range");
    expect(() => parseCron("* 24 * * *")).toThrow("out-of-range");
    expect(() => parseCron("* * * * */0")).toThrow("bad step");
    expect(() => parseCron("a * * * *")).toThrow();
  });

  it("accepts 7 as Sunday", () => {
    expect(parseCron("* * * * 7").dayOfWeek.has(0)).toBe(true);
  });
});

describe("matchesCron", () => {
  it("matches every minute", () => {
    const fields = parseCron("* * * * *");
    expect(matchesCron(fields, at(2024, 1, 1, 3, 4))).toBe(true);
  });

  it("matches a fixed time exactly", () => {
    const fields = parseCron("0 9 * * *");
    expect(matchesCron(fields, at(2024, 1, 1, 9, 0))).toBe(true);
    expect(matchesCron(fields, at(2024, 1, 1, 9, 1))).toBe(false);
    expect(matchesCron(fields, at(2024, 1, 1, 10, 0))).toBe(false);
  });

  it("honours steps and lists", () => {
    const fields = parseCron("*/15 8,20 * * *");
    expect(matchesCron(fields, at(2024, 1, 1, 8, 30))).toBe(true);
    expect(matchesCron(fields, at(2024, 1, 1, 20, 45))).toBe(true);
    expect(matchesCron(fields, at(2024, 1, 1, 9, 30))).toBe(false);
  });

  it("uses OR semantics when both day fields are restricted", () => {
    const fields = parseCron("0 0 13 * 5"); // the 13th OR any Friday
    expect(matchesCron(fields, at(2024, 1, 13, 0, 0))).toBe(true); // a Saturday 13th
    expect(matchesCron(fields, at(2024, 1, 12, 0, 0))).toBe(true); // a Friday
    expect(matchesCron(fields, at(2024, 1, 11, 0, 0))).toBe(false); // Thursday 11th
  });

  it("uses AND semantics when one day field is a wildcard", () => {
    const fields = parseCron("0 0 * * 1"); // any Monday
    expect(matchesCron(fields, at(2024, 1, 1, 0, 0))).toBe(true);
    expect(matchesCron(fields, at(2024, 1, 2, 0, 0))).toBe(false);
  });
});

describe("nextRunForExpression", () => {
  it("advances to the next minute for * * * * *", () => {
    const next = nextRunForExpression("* * * * *", at(2024, 1, 1, 8, 30))!;
    expect([next.getHours(), next.getMinutes()]).toEqual([8, 31]);
  });

  it("finds the next daily run, rolling to tomorrow when today passed", () => {
    expect(nextRunForExpression("0 9 * * *", at(2024, 1, 1, 8, 30))!.getDate()).toBe(1);
    const tomorrow = nextRunForExpression("0 9 * * *", at(2024, 1, 1, 10, 0))!;
    expect([tomorrow.getDate(), tomorrow.getHours()]).toEqual([2, 9]);
  });

  it("handles step expressions", () => {
    const next = nextRunForExpression("*/15 * * * *", at(2024, 1, 1, 10, 7))!;
    expect([next.getHours(), next.getMinutes()]).toEqual([10, 15]);
  });

  it("finds the next weekday match", () => {
    // 2024-01-01 is a Monday.
    const next = nextRunForExpression("30 8 * * 1", at(2024, 1, 1, 0, 0))!;
    expect([next.getMonth() + 1, next.getDate(), next.getHours(), next.getMinutes()]).toEqual([1, 1, 8, 30]);
  });

  it("finds the next leap day", () => {
    const next = nextRunForExpression("0 0 29 2 *", at(2023, 1, 1, 0, 0))!;
    expect([next.getFullYear(), next.getMonth() + 1, next.getDate()]).toEqual([2024, 2, 29]);
  });

  it("returns null for an impossible day (31 February)", () => {
    expect(nextCronRun(parseCron("0 0 31 2 *"), at(2024, 1, 1, 0, 0))).toBeNull();
  });
});
