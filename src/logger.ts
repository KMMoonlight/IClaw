export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Explicit runtime override (setLogLevel); null means "read ICLAW_LOG_LEVEL lazily". */
let override: LogLevel | null = null;

/**
 * Resolve the effective level at emit time (not import time), so `ICLAW_LOG_LEVEL`
 * also works when it comes from `.env` — the env file is only loaded by
 * `loadConfig()`, which runs after this module is imported.
 */
function effectiveLevel(): LogLevel {
  if (override) return override;
  const v = process.env.ICLAW_LOG_LEVEL?.trim().toLowerCase();
  if (v && v in LEVEL_ORDER) return v as LogLevel;
  return "info";
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  withAccount(accountId: string): Logger;
  getLogFilePath(): string;
}

function emit(level: LogLevel, prefix: string, msg: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[effectiveLevel()]) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}]${prefix} ${msg}`;
  // Single stream (stderr) so it never corrupts stdout used by QR/CLI output.
  process.stderr.write(line + "\n");
}

function makeLogger(prefix = ""): Logger {
  return {
    debug: (m) => emit("debug", prefix, m),
    info: (m) => emit("info", prefix, m),
    warn: (m) => emit("warn", prefix, m),
    error: (m) => emit("error", prefix, m),
    withAccount: (accountId) => makeLogger(`${prefix} [${accountId}]`),
    getLogFilePath: () => "(stderr)",
  };
}

export const logger: Logger = makeLogger();

export function setLogLevel(level: LogLevel): void {
  override = level;
}

/** Clear the runtime override so ICLAW_LOG_LEVEL takes effect again (mainly for tests). */
export function resetLogLevelOverride(): void {
  override = null;
}
