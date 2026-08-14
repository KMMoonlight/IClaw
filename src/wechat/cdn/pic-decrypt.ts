// Adapted from Tencent/openclaw-weixin (MIT License). See docs/THIRD_PARTY_NOTICES.md.
import { decryptAesEcb } from "./aes-ecb.js";
import { buildCdnDownloadUrl, ENABLE_CDN_URL_FALLBACK } from "./cdn-url.js";
import { logger } from "../../logger.js";

/** Bound the download so a stalled CDN connection cannot freeze the channel loop. */
const CDN_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Safety cap enforced while streaming the response body. */
const CDN_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

async function fetchCdnBytes(url: string, label: string, maxBytes: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDN_DOWNLOAD_TIMEOUT_MS);
  let res: Response;
  try {
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      const cause = (err as NodeJS.ErrnoException).cause ?? (err as NodeJS.ErrnoException).code ?? "(no cause)";
      logger.error(`${label}: fetch network error url=${url} err=${String(err)} cause=${String(cause)}`);
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new Error(`${label}: CDN download ${res.status} ${res.statusText} body=${body}`);
    }
    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength > maxBytes) {
      throw new Error(`${label}: CDN content-length ${contentLength} exceeds max ${maxBytes} bytes`);
    }
    // Stream the body with a hard cap, aborting as soon as it is exceeded.
    const reader = res.body?.getReader();
    if (!reader) return Buffer.from(await res.arrayBuffer());
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new Error(`${label}: CDN body exceeds max ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 * Two encodings seen in the wild:
 *   - base64(16 raw bytes)              -> images
 *   - base64(hex string of 16 bytes)    -> file / voice / video
 */
function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(
    `${label}: aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`,
  );
}

/** Download and AES-128-ECB decrypt a CDN media file. Returns plaintext Buffer. */
export async function downloadAndDecryptBuffer(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
  label: string,
  fullUrl?: string,
  maxBytes: number = CDN_DOWNLOAD_MAX_BYTES,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64, label);
  let url: string;
  if (fullUrl) {
    url = fullUrl;
  } else if (ENABLE_CDN_URL_FALLBACK) {
    url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  } else {
    throw new Error(`${label}: fullUrl is required (CDN URL fallback is disabled)`);
  }
  const encrypted = await fetchCdnBytes(url, label, maxBytes);
  return decryptAesEcb(encrypted, key);
}

/** Download plain (unencrypted) bytes from the CDN. */
export async function downloadPlainCdnBuffer(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  label: string,
  fullUrl?: string,
  maxBytes: number = CDN_DOWNLOAD_MAX_BYTES,
): Promise<Buffer> {
  let url: string;
  if (fullUrl) {
    url = fullUrl;
  } else if (ENABLE_CDN_URL_FALLBACK) {
    url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  } else {
    throw new Error(`${label}: fullUrl is required (CDN URL fallback is disabled)`);
  }
  return fetchCdnBytes(url, label, maxBytes);
}
