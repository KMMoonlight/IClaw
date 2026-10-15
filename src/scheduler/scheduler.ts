import { logger } from "../logger.js";
import { inc } from "../metrics.js";
import { computeNextRunAt, listDueScheduledTasks, updateScheduledTask } from "./tasks.js";
import type { ScheduledTask } from "./tasks.js";

export type TaskHandler = (task: ScheduledTask) => Promise<void> | void;

export interface RunDueOptions {
  now?: number;
  onError?: (task: ScheduledTask, err: unknown) => void;
}

/**
 * Run every due task once (soonest first) and advance its schedule.
 *  - "once" tasks are marked done;
 *  - "cron" tasks are rescheduled from `now` (missed periods while offline are skipped).
 * A handler error is reported and the schedule still advances, so a failing task
 * cannot wedge the loop in a tight retry.
 */
export async function runDueTasks(handler: TaskHandler, options: RunDueOptions = {}): Promise<number> {
  const now = options.now ?? Date.now();
  const onError = options.onError ?? ((task, err) => logger.warn(`scheduler: task ${task.id} failed: ${String(err)}`));
  const due = listDueScheduledTasks(now);
  let fired = 0;

  for (const task of due) {
    try {
      await handler(task);
    } catch (err) {
      onError(task, err);
    }
    fired += 1;
    inc("iclaw_scheduled_tasks_run_total");

    if (task.kind === "once") {
      updateScheduledTask(task.id, { status: "done", lastRunAt: now });
      continue;
    }
    const next = computeNextRunAt("cron", task.spec, now);
    if (next === null) {
      updateScheduledTask(task.id, { status: "done", lastRunAt: now });
    } else {
      updateScheduledTask(task.id, { status: "active", lastRunAt: now, nextRunAt: next });
    }
  }
  return fired;
}

export interface StartSchedulerOptions {
  intervalMs: number;
  handler: TaskHandler;
  onError?: (task: ScheduledTask, err: unknown) => void;
  /** Run a pass immediately on start (default true) to pick up anything missed while down. */
  runOnStart?: boolean;
  /** Extra job to run after each task pass (e.g. event watchers). */
  afterTasks?: () => Promise<void> | void;
}

let running: { stop: () => void } | null = null;

/** Start the periodic scheduler. Idempotent; returns a stop function. */
export function startScheduler(options: StartSchedulerOptions): () => void {
  if (running) return running.stop;

  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return; // never overlap passes
    inFlight = true;
    try {
      await runDueTasks(options.handler, { onError: options.onError });
      if (options.afterTasks) await options.afterTasks();
    } catch (err) {
      logger.error(`scheduler: pass failed: ${String(err)}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  // Do not keep the event loop alive solely for the scheduler.
  timer.unref?.();

  const stop = (): void => {
    clearInterval(timer);
    running = null;
  };
  running = { stop };

  if (options.runOnStart !== false) void tick();
  return stop;
}

export function isSchedulerRunning(): boolean {
  return running !== null;
}

export function stopScheduler(): void {
  running?.stop();
}
