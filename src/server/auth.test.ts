import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { resetConfigCache } from "../config.js";
import { generateAdminPassword, hashPassword, signSession, verifyPassword, verifySession } from "./auth.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-auth-test-"));
const origStateDir = process.env.ICLAW_STATE_DIR;

beforeAll(() => {
  process.env.ICLAW_STATE_DIR = stateDir;
  resetConfigCache();
});

afterAll(() => {
  if (origStateDir === undefined) delete process.env.ICLAW_STATE_DIR;
  else process.env.ICLAW_STATE_DIR = origStateDir;
  resetConfigCache();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", () => {
    const stored = hashPassword("s3cret");
    expect(stored.startsWith("scrypt:")).toBe(true);
    expect(verifyPassword("s3cret", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  it("produces a unique salt per hash", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored hashes", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "bcrypt:aa:bb")).toBe(false);
  });
});

describe("session tokens", () => {
  it("round-trips a signed session", () => {
    const token = signSession("admin");
    expect(verifySession(token)).toBe("admin");
  });

  it("rejects garbage, tampered payloads and tampered signatures", () => {
    expect(verifySession(undefined)).toBeNull();
    expect(verifySession("")).toBeNull();
    expect(verifySession("no-dot")).toBeNull();
    expect(verifySession("a.b.c")).toBeNull();

    const token = signSession("admin");
    const dot = token.indexOf(".");
    const payload = token.slice(0, dot);
    // Tamper with the payload without updating the signature.
    const flipped = payload.startsWith("A") ? `B${payload.slice(1)}` : `A${payload.slice(1)}`;
    expect(verifySession(`${flipped}.${token.slice(dot + 1)}`)).toBeNull();
  });

  it("rejects expired tokens", () => {
    // Craft a token with an already-expired expiry using the persisted secret.
    const secretHex = fs.readFileSync(path.join(stateDir, "admin-secret"), "utf-8").trim();
    const payload = Buffer.from(JSON.stringify({ u: "admin", e: Date.now() - 60_000 })).toString("base64url");
    const sig = crypto.createHmac("sha256", Buffer.from(secretHex, "hex")).update(payload).digest("base64url");
    expect(verifySession(`${payload}.${sig}`)).toBeNull();
  });

  it("generates admin passwords", () => {
    const pw = generateAdminPassword();
    expect(typeof pw).toBe("string");
    expect(pw.length).toBeGreaterThanOrEqual(8);
  });
});
