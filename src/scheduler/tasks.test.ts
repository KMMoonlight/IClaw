import { beforeEach, describe, expect, it } from "vitest";

import { createUser, openDbInMemory } from "../db/index.js";
import {
  computeNextRunAt,
  countActiveScheduledTasks,
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  isCronExpression,
  listDueScheduledTasks,
  listScheduledTasks,
  parseOnceSpec,
  parseRelativeSpec,
  parseTaskPayload,
  resolveScheduleSpec,
  updateScheduledTask,
} from "./tasks.js";

beforeEach(() => {
  openDbInMemory();
});

describe("parseOnceSpec", () => {
  it("accepts epoch milliseconds and date strings", () => {
    expect(parseOnceSpec("1700000000000")).toBe(1700000000000);
    expect(parseOnceSpec("2024-01-01T09:00:00.000Z")).toBe(Date.parse("2024-01-01T09:00:00.000Z"));
    expect(() => parseOnceSpec("not a date")).toThrow("无法解析");
  });
});

describe("computeNextRunAt", () => {
  it("returns the exact time for a one-off task", () => {
    expect(computeNextRunAt("once", "1700000000000")).toBe(1700000000000);
  });

  it("computes the next cron occurrence after `from`", () => {
    const from = new Date(2024, 0, 1, 8, 30).getTime();
    const next = computeNextRunAt("cron", "0 9 * * *", from)!;
    expect(new Date(next).getHours()).toBe(9);
    expect(next).toBeGreaterThan(from);
  });

  it("parses relative offsets", () => {
    const now = 1_000_000;
    expect(parseRelativeSpec("+10m", now)).toBe(now + 600_000);
    expect(parseRelativeSpec("+2h", now)).toBe(now + 7_200_000);
    expect(parseRelativeSpec("+1d", now)).toBe(now + 86_400_000);
    expect(parseRelativeSpec("+30s", now)).toBe(now + 30_000);
    expect(parseRelativeSpec("tomorrow", now)).toBeNull();
  });

  it("resolves cron, relative, ISO and epoch specs", () => {
    expect(isCronExpression("0 9 * * *")).toBe(true);
    expect(isCronExpression("+10m")).toBe(false);

    expect(resolveScheduleSpec("0 9 * * *", Date.now()).kind).toBe("cron");
    const relative = resolveScheduleSpec("+10m", 1_000_000);
    expect(relative.kind).toBe("once");
    expect(relative.nextRunAt).toBe(1_600_000);
    const iso = resolveScheduleSpec("2024-01-01T09:00:00.000Z");
    expect(iso.kind).toBe("once");
    expect(iso.nextRunAt).toBe(Date.parse("2024-01-01T09:00:00.000Z"));
    expect(() => resolveScheduleSpec("garbage")).toThrow();
    expect(() => resolveScheduleSpec("  ")).toThrow();
  });

  it("parses the task payload mode", () => {
    expect(parseTaskPayload(null)).toEqual({ mode: "message" });
    expect(parseTaskPayload('{"mode":"agent"}')).toEqual({ mode: "agent" });
    expect(parseTaskPayload('{"mode":"bogus"}')).toEqual({ mode: "message" });
    expect(parseTaskPayload("broken")).toEqual({ mode: "message" });
  });
});

describe("scheduled task CRUD", () => {
  it("creates a task with a computed next run", () => {
    const u = createUser("u");
    const task = createScheduledTask({ userId: u.id, kind: "cron", spec: "0 9 * * *", prompt: "早起提醒" });
    expect(task.status).toBe("active");
    expect(task.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    expect(getScheduledTask(task.id)?.prompt).toBe("早起提醒");
  });

  it("rejects an unparseable spec", () => {
    const u = createUser("u");
    expect(() => createScheduledTask({ userId: u.id, kind: "once", spec: "nonsense", prompt: "x" })).toThrow();
  });

  it("lists tasks scoped to a user, soonest first", () => {
    const a = createUser("a");
    const b = createUser("b");
    createScheduledTask({ userId: a.id, kind: "once", spec: "1700000000000", prompt: "later" });
    createScheduledTask({ userId: a.id, kind: "once", spec: "1600000000000", prompt: "earlier" });
    createScheduledTask({ userId: b.id, kind: "once", spec: "1500000000000", prompt: "other" });
    expect(listScheduledTasks(a.id).map((t) => t.prompt)).toEqual(["earlier", "later"]);
    expect(listScheduledTasks()).toHaveLength(3);
  });

  it("finds due active tasks only", () => {
    const u = createUser("u");
    createScheduledTask({ userId: u.id, kind: "once", spec: "1000", prompt: "past", nextRunAt: 1000 });
    createScheduledTask({ userId: u.id, kind: "once", spec: "9999999999999", prompt: "future" });
    const paused = createScheduledTask({ userId: u.id, kind: "once", spec: "1000", prompt: "paused", nextRunAt: 1000 });
    updateScheduledTask(paused.id, { status: "paused" });
    const due = listDueScheduledTasks(2000);
    expect(due.map((t) => t.prompt)).toEqual(["past"]);
  });

  it("updates and deletes tasks, and counts active ones", () => {
    const u = createUser("u");
    const task = createScheduledTask({ userId: u.id, kind: "cron", spec: "* * * * *", prompt: "a" });
    expect(countActiveScheduledTasks(u.id)).toBe(1);
    const updated = updateScheduledTask(task.id, { prompt: "b", status: "paused" })!;
    expect(updated.prompt).toBe("b");
    expect(updated.status).toBe("paused");
    expect(countActiveScheduledTasks(u.id)).toBe(0);
    expect(updateScheduledTask("missing", { prompt: "x" })).toBeNull();
    expect(deleteScheduledTask(task.id)).toBe(true);
    expect(deleteScheduledTask(task.id)).toBe(false);
    expect(getScheduledTask(task.id)).toBeNull();
  });
});
