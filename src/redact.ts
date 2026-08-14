/** Mask a bearer token / secret so it never lands in logs. */
export function redactToken(token: string | undefined | null): string {
  if (!token) return "";
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/** Mask `Authorization` / `bot_token` / `aeskey` values in JSON-ish bodies. */
export function redactBody(raw: string): string {
  if (!raw) return raw;
  return raw
    .replace(/"Authorization"\s*:\s*"[^"]*"/gi, '"Authorization":"Bearer ***"')
    .replace(/("bot_token"\s*:\s*")[^"]*(")/gi, "$1***$2")
    .replace(/("aes_key"\s*:\s*")[^"]*(")/gi, "$1***$2")
    .replace(/("aeskey"\s*:\s*")[^"]*(")/gi, "$1***$2");
}

/** Strip query params that may be sensitive (qrcode, verify_code). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of ["qrcode", "verify_code", "encrypted_query_param"]) {
      if (u.searchParams.has(key)) u.searchParams.set(key, "***");
    }
    return u.toString();
  } catch {
    return url;
  }
}
