import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createUser, openDbInMemory } from "../db/index.js";
import { isSchedulerRunning, runDueTasks, startScheduler, stopScheduler } from "./scheduler.js";
import { createScheduledTask, getScheduledTask, updateScheduledTask } from "./tasks.js";
import type { ScheduledTask } from "./tasks.js";

beforeEach(() => {
  openDbInMemory();
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

describe("runDueTasks", () => {
  it("runs due one-off tasks once and marks them done", async () => {
    const u = createUser("u");
    const task = createScheduledTask({ userId: u.id, kind: "once", spec: "1000", prompt: "ping", nextRunAt: 1000 });
    const seen: ScheduledTask[] = [];
    const fired = await runDueTasks((t) => void seen.push(t), { now: 2000 });
    expect(fired).toBe(1);
    expect(seen[0]!.id).toBe(task.id);
    expect(getScheduledTask(task.id)!.status).toBe("done");

    // A second pass does not re-run it.
    expect(await runDueTasks(() => {}, { now: 3000 })).toBe(0);
  });

  it("does not run future tasks", async () => {
    const u = createUser("u");
    createScheduledTask({ userId: u.id, kind: "once", spec: "100000", prompt: "later", nextRunAt: 100_000 });
    expect(await runDueTasks(() => {}, { now: 2000 })).toBe(0);
  });

  it("reschedules cron tasks and records last run", async () => {
    const u = createUser("u");
    const from = new Date(2024, 0, 1, 8, 30).getTime();
    const task = createScheduledTask({ userId: u.id, kind: "cron", spec: "0 9 * * *", prompt: "daily", nextRunAt: from });
    await runDueTasks(() => {}, { now: from + 1000 });
    const updated = getScheduledTask(task.id)!;
    expect(updated.status).toBe("active");
    expect(updated.lastRunAt).toBe(from + 1000);
    expect(updated.nextRunAt).toBeGreaterThan(from + 1000);
  });

  it("swallows handler errors, advances the schedule and reports them", async () => {
    const u = createUser("u");
    const task = createScheduledTask({ userId: u.id, kind: "cron", spec: "0 9 * * *", prompt: "x", nextRunAt: 1000 });
    const onError = vi.fn();
    const fired = await runDueTasks(
      () => {
        throw new Error("boom");
      },
      { now: 2000, onError },
    );
    expect(fired).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(getScheduledTask(task.id)!.status).toBe("active");
  });

  it("marks a cron task done when it can never match again", async () => {
    const u = createUser("u");
    const task = createScheduledTask({ userId: u.id, kind: "cron", spec: "0 0 31 2 *", prompt: "never", nextRunAt: 1000 });
    await runDueTasks(() => {}, { now: 2000 });
    expect(getScheduledTask(task.id)!.status).toBe("done");
  });

  it("runs tasks in due order", async () => {
    const u = createUser("u");
    createScheduledTask({ userId: u.id, kind: "once", spec: "1000", prompt: "second", nextRunAt: 2000 });
    createScheduledTask({ userId: u.id, kind: "once", spec: "1000", prompt: "first", nextRunAt: 1000 });
    const order: string[] = [];
    await runDueTasks((t) => void order.push(t.prompt), { now: 3000 });
    expect(order).toEqual(["first", "second"]);
  });
});

describe("startScheduler", () => {
  it("runs a pass on start and periodically, and stops cleanly", async () => {
    vi.useFakeTimers();
    const u = createUser("u");
    createScheduledTask({ userId: u.id, kind: "once", spec: "1000", prompt: "hi", nextRunAt: 0 });

    const handler = vi.fn();
    const stop = startScheduler({ intervalMs: 1000, handler });
    expect(isSchedulerRunning()).toBe(true);

    await vi.advanceTimersByTimeAsync(0); // flush the run-on-start pass
    expect(handler).toHaveBeenCalledTimes(1);

    // No new due task → later ticks do nothing.
    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).toHaveBeenCalledTimes(1);

    stop();
    expect(isSchedulerRunning()).toBe(false);
  });

  it("is idempotent while running", () => {
    const stop1 = startScheduler({ intervalMs: 10_000, handler: () => {}, runOnStart: false });
    const stop2 = startScheduler({ intervalMs: 10_000, handler: () => {}, runOnStart: false });
    expect(stop2).toBe(stop1);
    stop1();
    expect(isSchedulerRunning()).toBe(false);
  });

  it("runs the afterTasks job after each pass", async () => {
    vi.useFakeTimers();
    const afterTasks = vi.fn();
    const stop = startScheduler({ intervalMs: 1000, handler: () => {}, afterTasks });
    await vi.advanceTimersByTimeAsync(0);
    expect(afterTasks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(afterTasks).toHaveBeenCalledTimes(2);
    stop();
  });
});
