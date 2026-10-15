/** Tracks in-flight work so shutdown can drain it before exiting. */

let count = 0;
const waiters = new Set<() => void>();

export function beginWork(): void {
  count += 1;
}

export function endWork(): void {
  if (count > 0) count -= 1;
  if (count === 0) {
    for (const waiter of waiters) waiter();
    waiters.clear();
  }
}

export function inflightCount(): number {
  return count;
}

/** Resolve when no work is in flight (immediately if already idle). */
export function onIdle(): Promise<void> {
  if (count === 0) return Promise.resolve();
  return new Promise((resolve) => waiters.add(resolve));
}

/** Wait up to `timeoutMs` for idle. Returns true when drained, false on timeout. */
export function waitForIdle(timeoutMs: number): Promise<boolean> {
  if (count === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiters.delete(done);
      resolve(false);
    }, timeoutMs);
    waiters.add(done);
  });
}

/** Reset state (tests). */
export function resetInflight(): void {
  count = 0;
  waiters.clear();
}
