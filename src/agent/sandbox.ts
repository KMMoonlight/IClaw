import { spawnSync } from "node:child_process";
import fs from "node:fs";

export type SandboxMode = "auto" | "required" | "none";

export interface SandboxPlan {
  file: string;
  args: string[];
  kind: "bwrap" | "sandbox-exec";
}

export interface SandboxOptions {
  mode: SandboxMode;
  /** Allow outbound network inside the sandbox (default deny). */
  allowNetwork: boolean;
  platform?: NodeJS.Platform;
  hasTool?: (name: string) => boolean;
}

export interface SandboxDecision {
  plan: SandboxPlan | null;
  reason: string;
}

/** Default tool availability probe (`which <name>`). */
export function hasToolDefault(name: string): boolean {
  try {
    return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** bubblewrap plan (Linux): read-only system dirs, writable workspace, no network by default. */
export function buildBwrap(command: string, workspace: string, allowNetwork: boolean): SandboxPlan {
  const args: string[] = [];
  for (const dir of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
    if (fs.existsSync(dir)) args.push("--ro-bind", dir, dir);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  args.push("--bind", workspace, workspace, "--chdir", workspace);
  args.push("--unshare-pid");
  if (!allowNetwork) args.push("--unshare-net");
  args.push("--die-with-parent", "--", "/bin/sh", "-c", command);
  return { file: "bwrap", args, kind: "bwrap" };
}

/** macOS seatbelt profile: deny by default, allow system reads + workspace read/write. */
export function seatbeltProfile(workspace: string, allowNetwork: boolean): string {
  const ro = ["/usr", "/bin", "/sbin", "/System", "/Library", "/private/tmp"].map(
    (p) => `(subpath "${p}")`,
  );
  const devRead = ["/dev/null", "/dev/random", "/dev/urandom", "/dev/fd"].map((p) => `(subpath "${p}")`);
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    `(allow file-read* ${[...ro, ...devRead, `(subpath "${workspace}")`].join(" ")})`,
    `(allow file-write* (subpath "${workspace}") (subpath "/private/tmp") (literal "/dev/null"))`,
  ];
  if (allowNetwork) lines.push("(allow network*)");
  return lines.join("\n");
}

/** sandbox-exec plan (macOS). */
export function buildSeatbelt(command: string, workspace: string, allowNetwork: boolean): SandboxPlan {
  return {
    file: "sandbox-exec",
    args: ["-p", seatbeltProfile(workspace, allowNetwork), "/bin/sh", "-c", command],
    kind: "sandbox-exec",
  };
}

/**
 * Decide how to run a command. Returns a plan when a sandbox tool is available;
 * otherwise `plan: null` with a reason (callers decide whether to hard-fail).
 */
export function planSandbox(command: string, workspace: string, options: SandboxOptions): SandboxDecision {
  if (options.mode === "none") return { plan: null, reason: "sandbox disabled (ICLAW_EXEC_SANDBOX=none)" };
  const platform = options.platform ?? process.platform;
  const hasTool = options.hasTool ?? hasToolDefault;
  if (platform === "linux" && hasTool("bwrap")) {
    return { plan: buildBwrap(command, workspace, options.allowNetwork), reason: "bwrap" };
  }
  if (platform === "darwin" && hasTool("sandbox-exec")) {
    return { plan: buildSeatbelt(command, workspace, options.allowNetwork), reason: "sandbox-exec" };
  }
  return { plan: null, reason: `no sandbox tool available on ${platform}` };
}
