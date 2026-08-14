import crypto from "node:crypto";

/** Generate a short unique id with a readable prefix. */
export function generateId(prefix: string): string {
  const hex = crypto.randomBytes(12).toString("hex");
  return `${prefix}-${hex}`;
}

/** Generate a random token (e.g. session token). */
export function randomToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/** Constant-time string comparison (for password/session checks). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
