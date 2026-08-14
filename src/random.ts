import crypto from "node:crypto";

/** Generate a short unique id with a readable prefix. */
export function generateId(prefix: string): string {
  const hex = crypto.randomBytes(12).toString("hex");
  return `${prefix}-${hex}`;
}

/** Generate a random token (e.g. invite code / session token). */
export function randomToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1

/** Generate a short, unambiguous, case-insensitive invite code. */
export function generateInviteCode(length = 8): string {
  const bytes = crypto.randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) {
    code += INVITE_ALPHABET[bytes[i]! % INVITE_ALPHABET.length];
  }
  return code;
}

/** Constant-time string comparison (for password/session checks). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
