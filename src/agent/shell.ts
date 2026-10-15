import { spawn } from "node:child_process";

export interface RunShellOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Extra env merged over the minimal whitelist. */
  env?: Record<string, string>;
  /** Shell to use (defaults to /bin/sh). */
  shell?: string;
  /** When set, run this sandboxed command instead of `shell -c command`. */
  sandbox?: { file: string; args: string[] };
}

export interface RunShellResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
}

/** Build a minimal environment for child processes (never inherit secrets). */
export function minimalEnv(cwd: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: cwd,
    LANG: process.env.LANG ?? "C.UTF-8",
    ...extra,
  };
}

/**
 * Run a shell command in `cwd` with a hard timeout and a combined output cap.
 * Output beyond the cap terminates the process and marks the result truncated.
 */
export function runShell(command: string, options: RunShellOptions): Promise<RunShellResult> {
  const { cwd, timeoutMs, maxOutputBytes, env, shell = "/bin/sh", sandbox } = options;
  return new Promise((resolve) => {
    let child;
    try {
      const [file, args] = sandbox ? [sandbox.file, sandbox.args] : [shell, ["-c", command]];
      child = spawn(file, args, {
        cwd,
        env: minimalEnv(cwd, env),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        command,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command, stdout, stderr, exitCode, signal, timedOut, truncated });
    };

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (truncated) return; // stop accumulating once the cap is hit
      bytes += chunk.byteLength;
      const text = chunk.toString("utf-8");
      if (target === "stdout") stdout += text;
      else stderr += text;
      if (bytes > maxOutputBytes) {
        truncated = true;
        // Hard-cap what we keep, then terminate the process.
        stdout = stdout.slice(0, maxOutputBytes);
        stderr = stderr.slice(0, maxOutputBytes);
        child.kill("SIGKILL");
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1, timeoutMs));

    child.on("error", (err) => {
      stderr += (stderr ? "\n" : "") + (err instanceof Error ? err.message : String(err));
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}
