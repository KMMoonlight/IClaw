import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetConfigCache } from "../config.js";
import {
  clearContextTokensForAccount,
  getContextToken,
  restoreContextTokens,
  setContextToken,
} from "./context-token.js";

let stateDir: string;
const origStateDir = process.env.ICLAW_STATE_DIR;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-ctx-test-"));
  process.env.ICLAW_STATE_DIR = stateDir;
  resetConfigCache();
});

afterAll(() => {
  if (origStateDir === undefined) delete process.env.ICLAW_STATE_DIR;
  else process.env.ICLAW_STATE_DIR = origStateDir;
  resetConfigCache();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("context tokens", () => {
  it("stores and retrieves per account+user", () => {
    expect(getContextToken("acc", "u1")).toBeUndefined();
    setContextToken("acc", "u1", "tok-1");
    setContextToken("acc", "u2", "tok-2");
    setContextToken("acc2", "u1", "tok-3");
    expect(getContextToken("acc", "u1")).toBe("tok-1");
    expect(getContextToken("acc", "u2")).toBe("tok-2");
    expect(getContextToken("acc2", "u1")).toBe("tok-3");
  });

  it("persists to disk and restores", () => {
    setContextToken("acc-persist", "u1", "persisted-tok");
    const file = path.join(stateDir, "wechat", "accounts", "acc-persist.context-tokens.json");
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ u1: "persisted-tok" });
    // restore() re-reads the same file; the map keeps the value.
    restoreContextTokens("acc-persist");
    expect(getContextToken("acc-persist", "u1")).toBe("persisted-tok");
  });

  it("clears tokens and removes the file for an account", () => {
    setContextToken("acc-clear", "u1", "tok");
    clearContextTokensForAccount("acc-clear");
    expect(getContextToken("acc-clear", "u1")).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, "wechat", "accounts", "acc-clear.context-tokens.json"))).toBe(false);
  });
});
