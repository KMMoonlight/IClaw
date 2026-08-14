export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = process.env.ICLAW_LOG_LEVEL
  ? (process.env.ICLAW_LOG_LEVEL as LogLevel)
  : "info";

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  withAccount(accountId: string): Logger;
  getLogFilePath(): string;
}

function emit(level: LogLevel, prefix: string, msg: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
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
  currentLevel = level;
}
