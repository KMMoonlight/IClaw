import fs from "node:fs";
import path from "node:path";

import { resolveWorkspaceDir } from "../config.js";

/** Absolute, per-user workspace root: `<workspaceDir>/<userId>`. Created on demand. */
export function workspaceForUser(userId: string): string {
  const safeId = userId.replace(/[^\w.-]/g, "_");
  const dir = path.join(resolveWorkspaceDir(), safeId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve a user-supplied relative path inside the user's workspace, rejecting
 * absolute paths and any traversal outside the workspace. Returns the absolute path.
 *
 * The check is symlink-aware: the nearest existing ancestor of the target is
 * `realpath`-resolved and must stay inside the (also realpath-resolved) root, so
 * a symlink planted in the workspace cannot be used to read/write outside it.
 */
export function resolveInWorkspace(userId: string, relativePath: string): string {
  const root = workspaceForUser(userId);
  const raw = (relativePath ?? "").trim();
  if (raw === "" || raw === ".") return root;
  if (path.isAbsolute(raw)) {
    throw new Error(`只允许工作目录内的相对路径：${relativePath}`);
  }
  const resolved = path.resolve(root, raw);
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(withSep)) {
    throw new Error(`路径越界（只能访问工作目录内）：${relativePath}`);
  }
  assertNoSymlinkEscape(root, resolved, relativePath);
  return resolved;
}

/** Reject targets whose real (symlink-resolved) location escapes the workspace root. */
function assertNoSymlinkEscape(root: string, target: string, relativePath: string): void {
  const realRoot = fs.realpathSync(root);
  const realTarget = nearestRealPath(target);
  const inside =
    realTarget === realRoot || realTarget.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
  if (!inside) {
    throw new Error(`路径越界（符号链接指向工作目录外）：${relativePath}`);
  }
}

/**
 * Real path of `target`'s nearest existing ancestor, resolving symlinks —
 * including *dangling* ones (a link whose destination does not exist yet), which
 * `fs.realpathSync` alone refuses to resolve. Symlink cycles fail closed.
 */
function nearestRealPath(target: string, seen = new Set<string>()): string {
  let probe = target;
  for (;;) {
    try {
      return fs.realpathSync(probe);
    } catch {
      // Not a resolvable existing path — it may be a dangling symlink.
      try {
        if (fs.lstatSync(probe).isSymbolicLink()) {
          if (seen.has(probe)) throw new Error("符号链接循环");
          seen.add(probe);
          const link = fs.readlinkSync(probe);
          return nearestRealPath(path.resolve(path.dirname(probe), link), seen);
        }
      } catch (err) {
        if (err instanceof Error && err.message === "符号链接循环") throw err;
        // Path does not exist at all — fall through and walk up to the parent.
      }
      const parent = path.dirname(probe);
      if (parent === probe) return probe; // reached the filesystem root
      probe = parent;
    }
  }
}
