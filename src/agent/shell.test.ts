import { describe, expect, it } from "vitest";
import os from "node:os";

import { minimalEnv, runShell } from "./shell.js";

const CWD = os.tmpdir();

describe("minimalEnv", () => {
  it("only exposes a safe whitelist", () => {
    const env = minimalEnv("/tmp/ws", { FOO: "bar" });
    expect(env.HOME).toBe("/tmp/ws");
    expect(env.FOO).toBe("bar");
    expect(env.PATH).toBeTruthy();
    expect(env.ICLAW_API_KEY).toBeUndefined();
  });
});

describe("runShell", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await runShell("echo hello", { cwd: CWD, timeoutMs: 5000, maxOutputBytes: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr and a non-zero exit code", async () => {
    const result = await runShell("echo boom 1>&2; exit 3", { cwd: CWD, timeoutMs: 5000, maxOutputBytes: 10_000 });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("boom");
  });

  it("kills a command that exceeds the timeout", async () => {
    const result = await runShell("sleep 5", { cwd: CWD, timeoutMs: 200, maxOutputBytes: 10_000 });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });

  it("truncates and kills when output exceeds the cap", async () => {
    const result = await runShell("yes", { cwd: CWD, timeoutMs: 5000, maxOutputBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(20_000);
  });

  it("reports command-not-found via the shell exit code", async () => {
    const result = await runShell("definitely-not-a-real-command-xyz", { cwd: CWD, timeoutMs: 5000, maxOutputBytes: 10_000 });
    expect(result.exitCode).not.toBe(0);
  });

  it("runs a provided sandbox plan instead of the raw shell", async () => {
    const result = await runShell("ignored", {
      cwd: CWD,
      timeoutMs: 5000,
      maxOutputBytes: 10_000,
      sandbox: { file: "/bin/sh", args: ["-c", "echo sandboxed"] },
    });
    expect(result.stdout.trim()).toBe("sandboxed");
  });
});
