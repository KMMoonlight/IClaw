import { randomUUID } from "node:crypto";

import { openDb } from "../db/index.js";

export type WatcherKind = "web_change" | "web_keyword";
export type WatcherStatus = "active" | "paused";

export interface Watcher {
  id: string;
  userId: string;
  kind: WatcherKind;
  /** JSON spec, e.g. `{"url":"https://...","keyword":"..."}`. */
  spec: string;
  prompt: string;
  /** Fingerprint of the last observed content (or keyword presence). */
  state: string | null;
  status: WatcherStatus;
  intervalMs: number;
  lastCheckedAt: number | null;
  createdAt: number;
}

export interface CreateWatcherInput {
  userId: string;
  kind: WatcherKind;
  spec: string;
  prompt: string;
  intervalMs?: number;
}

export const DEFAULT_WATCH_INTERVAL_MS = 5 * 60 * 1000;

function rowToWatcher(r: Record<string, unknown>): Watcher {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    kind: (r.kind as WatcherKind) ?? "web_change",
    spec: r.spec as string,
    prompt: (r.prompt as string) ?? "",
    state: (r.state as string | null) ?? null,
    status: (r.status as WatcherStatus) ?? "active",
    intervalMs: (r.interval_ms as number) ?? DEFAULT_WATCH_INTERVAL_MS,
    lastCheckedAt: (r.last_checked_at as number | null) ?? null,
    createdAt: r.created_at as number,
  };
}

export function createWatcher(input: CreateWatcherInput): Watcher {
  const watcher: Watcher = {
    id: randomUUID(),
    userId: input.userId,
    kind: input.kind,
    spec: input.spec,
    prompt: input.prompt,
    state: null,
    status: "active",
    intervalMs: input.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS,
    lastCheckedAt: null,
    createdAt: Date.now(),
  };
  openDb()
    .prepare(
      "INSERT INTO watchers (id, user_id, kind, spec, prompt, state, status, interval_ms, last_checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      watcher.id,
      watcher.userId,
      watcher.kind,
      watcher.spec,
      watcher.prompt,
      watcher.state,
      watcher.status,
      watcher.intervalMs,
      watcher.lastCheckedAt,
      watcher.createdAt,
    );
  return watcher;
}

export function getWatcher(id: string): Watcher | null {
  const r = openDb().prepare("SELECT * FROM watchers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToWatcher(r) : null;
}

export function listWatchers(userId?: string): Watcher[] {
  const rows = (
    userId
      ? openDb().prepare("SELECT * FROM watchers WHERE user_id = ? ORDER BY created_at ASC").all(userId)
      : openDb().prepare("SELECT * FROM watchers ORDER BY created_at ASC").all()
  ) as Record<string, unknown>[];
  return rows.map(rowToWatcher);
}

/** Active watchers whose interval has elapsed since the last check, oldest first. */
export function listWatchersToCheck(now: number): Watcher[] {
  const rows = openDb()
    .prepare(
      "SELECT * FROM watchers WHERE status = 'active' AND (last_checked_at IS NULL OR last_checked_at + interval_ms <= ?) ORDER BY COALESCE(last_checked_at, 0) ASC",
    )
    .all(now) as Record<string, unknown>[];
  return rows.map(rowToWatcher);
}

export function recordWatcherCheck(id: string, state: string, checkedAt: number): void {
  openDb().prepare("UPDATE watchers SET state = ?, last_checked_at = ? WHERE id = ?").run(state, checkedAt, id);
}

/** Record only the check time (used after a failed fetch so it isn't retried every tick). */
export function touchWatcherCheck(id: string, checkedAt: number): void {
  openDb().prepare("UPDATE watchers SET last_checked_at = ? WHERE id = ?").run(checkedAt, id);
}

export function setWatcherStatus(id: string, status: WatcherStatus): void {
  openDb().prepare("UPDATE watchers SET status = ? WHERE id = ?").run(status, id);
}

export function deleteWatcher(id: string): boolean {
  const res = openDb().prepare("DELETE FROM watchers WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

export function countActiveWatchers(userId: string): number {
  const r = openDb()
    .prepare("SELECT COUNT(*) AS n FROM watchers WHERE user_id = ? AND status = 'active'")
    .get(userId) as { n: number };
  return r.n;
}
