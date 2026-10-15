import { randomUUID } from "node:crypto";

import { openDb } from "../db/index.js";
import { nextRunForExpression } from "./cron.js";

export type ScheduledTaskKind = "once" | "cron";
export type ScheduledTaskStatus = "active" | "paused" | "done";

export type TaskMode = "message" | "agent";

export interface TaskPayload {
  mode: TaskMode;
}

/** Parse a task's opaque payload; unknown/invalid content defaults to a plain message. */
export function parseTaskPayload(payload: string | null): TaskPayload {
  if (!payload) return { mode: "message" };
  try {
    const parsed = JSON.parse(payload) as { mode?: unknown };
    return { mode: parsed.mode === "agent" ? "agent" : "message" };
  } catch {
    return { mode: "message" };
  }
}

export interface ScheduledTask {
  id: string;
  userId: string;
  kind: ScheduledTaskKind;
  /** For "once": ISO date or epoch-ms string. For "cron": a 5-field expression. */
  spec: string;
  /** What to do when the task fires (message text or an agent instruction). */
  prompt: string;
  /** Optional opaque JSON payload (e.g. delivery metadata). */
  payload: string | null;
  nextRunAt: number;
  lastRunAt: number | null;
  status: ScheduledTaskStatus;
  createdAt: number;
}

export interface CreateScheduledTaskInput {
  userId: string;
  kind: ScheduledTaskKind;
  spec: string;
  prompt: string;
  payload?: string | null;
  /** Defaults to the spec's next occurrence from now. */
  nextRunAt?: number;
}

/** Parse a one-off spec: epoch milliseconds (all digits) or any Date-parsable string. */
export function parseOnceSpec(spec: string): number {
  const trimmed = spec.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) throw new Error(`无法解析时间：${spec}（请用 ISO 时间或毫秒时间戳）`);
  return parsed;
}

/** Next firing time for a task spec, or null when a cron expression never matches. */
export function computeNextRunAt(kind: ScheduledTaskKind, spec: string, from = Date.now()): number | null {
  if (kind === "once") return parseOnceSpec(spec);
  const next = nextRunForExpression(spec, from);
  return next ? next.getTime() : null;
}

/** A spec with 5 whitespace-separated fields is treated as cron. */
export function isCronExpression(spec: string): boolean {
  return spec.trim().split(/\s+/).length === 5;
}

/** Parse a relative one-off spec like `+10m`, `+2h`, `+1d` (seconds/minutes/hours/days). */
export function parseRelativeSpec(spec: string, now = Date.now()): number | null {
  const m = spec.trim().match(/^\+(\d+)\s*([smhd])$/i);
  if (!m) return null;
  const amount = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const factor = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return now + amount * factor;
}

/**
 * Resolve a user/model supplied "when" value into a concrete schedule.
 * Accepts: cron expression, `+10m` relative offsets, ISO datetimes, epoch ms.
 */
export function resolveScheduleSpec(
  spec: string,
  now = Date.now(),
): { kind: ScheduledTaskKind; spec: string; nextRunAt: number } {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("when 不能为空");
  if (isCronExpression(trimmed)) {
    const next = computeNextRunAt("cron", trimmed, now);
    if (next === null) throw new Error(`cron 表达式永不匹配：${trimmed}`);
    return { kind: "cron", spec: trimmed, nextRunAt: next };
  }
  const relative = parseRelativeSpec(trimmed, now);
  if (relative !== null) {
    return { kind: "once", spec: new Date(relative).toISOString(), nextRunAt: relative };
  }
  return { kind: "once", spec: trimmed, nextRunAt: parseOnceSpec(trimmed) };
}

function rowToTask(r: Record<string, unknown>): ScheduledTask {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    kind: (r.kind as ScheduledTaskKind) ?? "once",
    spec: r.spec as string,
    prompt: (r.prompt as string) ?? "",
    payload: (r.payload as string | null) ?? null,
    nextRunAt: r.next_run_at as number,
    lastRunAt: (r.last_run_at as number | null) ?? null,
    status: (r.status as ScheduledTaskStatus) ?? "active",
    createdAt: r.created_at as number,
  };
}

export function createScheduledTask(input: CreateScheduledTaskInput): ScheduledTask {
  const nextRunAt = input.nextRunAt ?? computeNextRunAt(input.kind, input.spec);
  if (nextRunAt === null) throw new Error(`无法计算下一次执行时间：${input.spec}`);
  const task: ScheduledTask = {
    id: randomUUID(),
    userId: input.userId,
    kind: input.kind,
    spec: input.spec,
    prompt: input.prompt,
    payload: input.payload ?? null,
    nextRunAt,
    lastRunAt: null,
    status: "active",
    createdAt: Date.now(),
  };
  openDb()
    .prepare(
      "INSERT INTO scheduled_tasks (id, user_id, kind, spec, prompt, payload, next_run_at, last_run_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      task.id,
      task.userId,
      task.kind,
      task.spec,
      task.prompt,
      task.payload,
      task.nextRunAt,
      task.lastRunAt,
      task.status,
      task.createdAt,
    );
  return task;
}

export function getScheduledTask(id: string): ScheduledTask | null {
  const r = openDb().prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToTask(r) : null;
}

/** List tasks, optionally scoped to one user, soonest first. */
export function listScheduledTasks(userId?: string): ScheduledTask[] {
  const rows = (
    userId
      ? openDb().prepare("SELECT * FROM scheduled_tasks WHERE user_id = ? ORDER BY next_run_at ASC").all(userId)
      : openDb().prepare("SELECT * FROM scheduled_tasks ORDER BY next_run_at ASC").all()
  ) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

/** Active tasks whose next run is due at or before `now`, soonest first. */
export function listDueScheduledTasks(now: number): ScheduledTask[] {
  const rows = openDb()
    .prepare("SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC")
    .all(now) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export interface UpdateScheduledTaskPatch {
  spec?: string;
  prompt?: string;
  payload?: string | null;
  nextRunAt?: number;
  lastRunAt?: number | null;
  status?: ScheduledTaskStatus;
}

export function updateScheduledTask(id: string, patch: UpdateScheduledTaskPatch): ScheduledTask | null {
  const existing = getScheduledTask(id);
  if (!existing) return null;
  const merged: ScheduledTask = {
    ...existing,
    spec: patch.spec ?? existing.spec,
    prompt: patch.prompt ?? existing.prompt,
    payload: patch.payload === undefined ? existing.payload : patch.payload,
    nextRunAt: patch.nextRunAt ?? existing.nextRunAt,
    lastRunAt: patch.lastRunAt === undefined ? existing.lastRunAt : patch.lastRunAt,
    status: patch.status ?? existing.status,
  };
  openDb()
    .prepare(
      "UPDATE scheduled_tasks SET spec = ?, prompt = ?, payload = ?, next_run_at = ?, last_run_at = ?, status = ? WHERE id = ?",
    )
    .run(
      merged.spec,
      merged.prompt,
      merged.payload,
      merged.nextRunAt,
      merged.lastRunAt,
      merged.status,
      id,
    );
  return merged;
}

export function deleteScheduledTask(id: string): boolean {
  const res = openDb().prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

export function countActiveScheduledTasks(userId: string): number {
  const r = openDb()
    .prepare("SELECT COUNT(*) AS n FROM scheduled_tasks WHERE user_id = ? AND status = 'active'")
    .get(userId) as { n: number };
  return r.n;
}
