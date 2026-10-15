import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetConfigCache } from "../config.js";
import { resolveInWorkspace, workspaceForUser } from "./workspace.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-ws-test-"));
const orig = process.env.ICLAW_WORKSPACE_DIR;

beforeEach(() => {
  process.env.ICLAW_WORKSPACE_DIR = root;
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
});

afterAll(() => {
  if (orig === undefined) delete process.env.ICLAW_WORKSPACE_DIR;
  else process.env.ICLAW_WORKSPACE_DIR = orig;
  resetConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("workspaceForUser", () => {
  it("creates and returns a per-user directory", () => {
    const dir = workspaceForUser("user-1");
    expect(dir).toBe(path.join(root, "user-1"));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("sanitises ids so they cannot contain a path separator", () => {
    const dir = workspaceForUser("../evil");
    expect(dir).toBe(path.join(root, ".._evil"));
    expect(path.dirname(dir)).toBe(root);
  });
});

describe("resolveInWorkspace", () => {
  it("resolves relative paths inside the workspace", () => {
    const abs = resolveInWorkspace("user-1", "sub/dir/file.txt");
    expect(abs).toBe(path.join(root, "user-1", "sub/dir/file.txt"));
  });

  it("returns the root for empty/./", () => {
    expect(resolveInWorkspace("user-1", "")).toBe(path.join(root, "user-1"));
    expect(resolveInWorkspace("user-1", ".")).toBe(path.join(root, "user-1"));
  });

  it("rejects absolute paths", () => {
    expect(() => resolveInWorkspace("user-1", "/etc/passwd")).toThrow("相对路径");
  });

  it("rejects traversal outside the workspace", () => {
    expect(() => resolveInWorkspace("user-1", "../other-user/secret")).toThrow("越界");
    expect(() => resolveInWorkspace("user-1", "a/../../etc/passwd")).toThrow("越界");
  });

  it("rejects a symlink that points outside the workspace", () => {
    const dir = workspaceForUser("user-1");
    const link = path.join(dir, "escape-link");
    const secret = path.join(root, "secret.txt");
    fs.writeFileSync(secret, "top-secret");
    fs.symlinkSync(secret, link);
    expect(() => resolveInWorkspace("user-1", "escape-link")).toThrow("越界");
    // A path through a symlinked directory is rejected too.
    fs.symlinkSync(path.join(root, ".."), path.join(dir, "up-dir"));
    expect(() => resolveInWorkspace("user-1", "up-dir/whatever")).toThrow("越界");
  });

  it("rejects a *dangling* symlink whose target is outside the workspace", () => {
    const dir = workspaceForUser("user-1");
    const outsideDir = path.join(root, "outside-dir");
    fs.mkdirSync(outsideDir, { recursive: true });
    const missingTarget = path.join(outsideDir, "new.txt"); // does not exist yet
    fs.symlinkSync(missingTarget, path.join(dir, "dangling.txt"));
    expect(() => resolveInWorkspace("user-1", "dangling.txt")).toThrow("越界");
    // The file must not have been created outside the workspace.
    expect(fs.existsSync(missingTarget)).toBe(false);
  });

  it("rejects symlink cycles instead of looping", () => {
    const dir = workspaceForUser("user-1");
    fs.symlinkSync(path.join(dir, "b"), path.join(dir, "a"));
    fs.symlinkSync(path.join(dir, "a"), path.join(dir, "b"));
    expect(() => resolveInWorkspace("user-1", "a")).toThrow();
  });

  it("still allows a symlink that stays inside the workspace", () => {
    const dir = workspaceForUser("user-1");
    fs.writeFileSync(path.join(dir, "real.txt"), "ok");
    fs.symlinkSync(path.join(dir, "real.txt"), path.join(dir, "inside-link.txt"));
    expect(resolveInWorkspace("user-1", "inside-link.txt")).toBe(path.join(dir, "inside-link.txt"));
  });

  it("still allows paths that do not exist yet inside real subdirectories", () => {
    const dir = workspaceForUser("user-1");
    fs.mkdirSync(path.join(dir, "real"), { recursive: true });
    expect(resolveInWorkspace("user-1", "real/new/file.txt")).toBe(path.join(dir, "real/new/file.txt"));
  });
});
