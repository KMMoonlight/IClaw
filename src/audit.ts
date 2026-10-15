import { redactBody } from "./redact.js";

/** Compact, secret-redacted summary of tool arguments for the audit log. */
export function summarizeAuditArgs(args: unknown, max = 300): string {
  try {
    const json = redactBody(JSON.stringify(args ?? {}));
    return json.length > max ? `${json.slice(0, max)}…` : json;
  } catch {
    return "";
  }
}
