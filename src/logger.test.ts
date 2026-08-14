import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger, resetLogLevelOverride, setLogLevel } from "./logger.js";

const KEY = "ICLAW_LOG_LEVEL";
let writeSpy: ReturnType<typeof vi.spyOn>;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[KEY];
  writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  writeSpy.mockRestore();
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
  resetLogLevelOverride();
});

function linesContaining(needle: string): number {
  return writeSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes(needle)).length;
}

describe("logger levels", () => {
  it("emits info by default", () => {
    logger.info("msg-default-level");
    logger.debug("msg-default-debug");
    expect(linesContaining("msg-default-level")).toBe(1);
    expect(linesContaining("msg-default-debug")).toBe(0);
  });

  it("reads ICLAW_LOG_LEVEL lazily at emit time (works from .env)", () => {
    process.env[KEY] = "error";
    logger.info("msg-suppressed");
    logger.error("msg-shown");
    expect(linesContaining("msg-suppressed")).toBe(0);
    expect(linesContaining("msg-shown")).toBe(1);
  });

  it("falls back to info for unknown level values", () => {
    process.env[KEY] = "verbose";
    logger.info("msg-unknown-level");
    logger.debug("msg-unknown-debug");
    expect(linesContaining("msg-unknown-level")).toBe(1);
    expect(linesContaining("msg-unknown-debug")).toBe(0);
  });

  it("supports setLogLevel override and reset", () => {
    setLogLevel("error");
    logger.info("msg-override-suppressed");
    expect(linesContaining("msg-override-suppressed")).toBe(0);
    resetLogLevelOverride();
    logger.info("msg-override-restored");
    expect(linesContaining("msg-override-restored")).toBe(1);
  });
});
