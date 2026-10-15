import { describe, expect, it } from "vitest";

import { buildBwrap, buildSeatbelt, hasToolDefault, planSandbox, seatbeltProfile } from "./sandbox.js";

const WS = "/home/u/workspace";

describe("buildBwrap", () => {
  it("binds the workspace read-write and denies network by default", () => {
    const plan = buildBwrap("echo hi", WS, false);
    expect(plan.kind).toBe("bwrap");
    expect(plan.args).toEqual(expect.arrayContaining(["--bind", WS, WS, "--chdir", WS]));
    expect(plan.args).toContain("--unshare-net");
    expect(plan.args.slice(-3)).toEqual(["/bin/sh", "-c", "echo hi"]);
  });

  it("omits network isolation when allowed", () => {
    expect(buildBwrap("x", WS, true).args).not.toContain("--unshare-net");
  });
});

describe("seatbeltProfile / buildSeatbelt", () => {
  it("denies by default and allows the workspace", () => {
    const profile = seatbeltProfile(WS, false);
    expect(profile).toContain("(deny default)");
    expect(profile).toContain(`(subpath "${WS}")`);
    expect(profile).not.toContain("(allow network*)");
  });

  it("allows network only when requested", () => {
    expect(seatbeltProfile(WS, true)).toContain("(allow network*)");
    const plan = buildSeatbelt("ls", WS, true);
    expect(plan.kind).toBe("sandbox-exec");
    expect(plan.args[0]).toBe("-p");
    expect(plan.args.slice(-3)).toEqual(["/bin/sh", "-c", "ls"]);
  });
});

describe("planSandbox", () => {
  it("returns no plan when disabled", () => {
    expect(planSandbox("x", WS, { mode: "none", allowNetwork: false }).plan).toBeNull();
  });

  it("uses bwrap on linux when available", () => {
    const decision = planSandbox("x", WS, {
      mode: "auto",
      allowNetwork: false,
      platform: "linux",
      hasTool: (name) => name === "bwrap",
    });
    expect(decision.plan?.kind).toBe("bwrap");
  });

  it("uses sandbox-exec on darwin when available", () => {
    const decision = planSandbox("x", WS, {
      mode: "auto",
      allowNetwork: false,
      platform: "darwin",
      hasTool: (name) => name === "sandbox-exec",
    });
    expect(decision.plan?.kind).toBe("sandbox-exec");
  });

  it("returns no plan when the tool is missing", () => {
    const decision = planSandbox("x", WS, {
      mode: "required",
      allowNetwork: false,
      platform: "linux",
      hasTool: () => false,
    });
    expect(decision.plan).toBeNull();
    expect(decision.reason).toContain("no sandbox");
  });
});

describe("hasToolDefault", () => {
  it("returns a boolean", () => {
    expect(typeof hasToolDefault("definitely-not-a-tool-xyz")).toBe("boolean");
    expect(hasToolDefault("definitely-not-a-tool-xyz")).toBe(false);
  });
});
