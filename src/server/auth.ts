import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config.js";
import { randomToken } from "../random.js";

// ---------------------------------------------------------------------------
// Password hashing (scrypt, built-in)
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}

// ---------------------------------------------------------------------------
// Session tokens (HMAC-signed, stateless)
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

let secret: Buffer | null = null;

function getSecret(): Buffer {
  if (secret) return secret;
  const dir = resolveStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const secretFile = path.join(dir, "admin-secret");
  if (fs.existsSync(secretFile)) {
    secret = Buffer.from(fs.readFileSync(secretFile, "utf-8").trim(), "hex");
  } else {
    secret = crypto.randomBytes(32);
    fs.writeFileSync(secretFile, secret.toString("hex"), { mode: 0o600 });
  }
  return secret;
}

export function signSession(username: string): string {
  const payload = Buffer.from(
    JSON.stringify({ u: username, e: Date.now() + SESSION_TTL_MS }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(token: string | undefined): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { u?: string; e?: number };
    if (!data.u || !data.e || data.e < Date.now()) return null;
    return data.u;
  } catch {
    return null;
  }
}

export function generateAdminPassword(): string {
  return randomToken(9);
}
