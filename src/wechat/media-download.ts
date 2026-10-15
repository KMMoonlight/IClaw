// Adapted from Tencent/openclaw-weixin (MIT License). See docs/THIRD_PARTY_NOTICES.md.
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config.js";
import { logger } from "../logger.js";
import { downloadAndDecryptBuffer, downloadPlainCdnBuffer } from "./cdn/pic-decrypt.js";
import type { MessageItem } from "./types.js";
import { MessageItemType } from "./types.js";
import type { InboundMedia } from "./inbound.js";
const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

function inboundMediaDir(): string {
  return path.join(resolveStateDir(), "media", "inbound");
}

function saveMediaToTemp(buf: Buffer, ext: string): { path: string } {
  const dir = inboundMediaDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  if (buf.length > WEIXIN_MEDIA_MAX_BYTES) {
    throw new Error(`media exceeds max size (${buf.length} bytes)`);
  }
  fs.writeFileSync(filePath, buf);
  return { path: filePath };
}

/** Delete inbound media files older than `maxAgeMs` (default 7 days). Best-effort. */
export function purgeStaleInboundMedia(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): void {
  const dir = inboundMediaDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no media dir yet
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    try {
      if (fs.statSync(filePath).mtimeMs < cutoff) fs.rmSync(filePath, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/** Detect an image MIME type / extension from magic bytes (best-effort). */
export function sniffImageMime(buf: Buffer): { mime: string; ext: string } {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: "image/png", ext: ".png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }
  if (buf.length >= 6) {
    const head6 = buf.subarray(0, 6).toString("ascii");
    if (head6 === "GIF87a" || head6 === "GIF89a") return { mime: "image/gif", ext: ".gif" };
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mime: "image/webp", ext: ".webp" };
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return { mime: "image/bmp", ext: ".bmp" };
  return { mime: "image/jpeg", ext: ".jpg" };
}

/**
 * Download + decrypt an inbound IMAGE item. Returns media info, or null when
 * the item is not an image or has no usable CDN reference / key.
 */
export async function downloadImageFromItem(
  item: MessageItem,
  cdnBaseUrl: string,
): Promise<InboundMedia | null> {
  if (item.type !== MessageItemType.IMAGE) return null;
  const img = item.image_item;
  if (!img?.media?.encrypt_query_param && !img?.media?.full_url) return null;

  const aesKeyBase64 = img.aeskey
    ? Buffer.from(img.aeskey, "hex").toString("base64")
    : img.media.aes_key;

  try {
    const buf = aesKeyBase64
      ? await downloadAndDecryptBuffer(
          img.media.encrypt_query_param ?? "",
          aesKeyBase64,
          cdnBaseUrl,
          "image",
          img.media.full_url,
        )
      : await downloadPlainCdnBuffer(
          img.media.encrypt_query_param ?? "",
          cdnBaseUrl,
          "image-plain",
          img.media.full_url,
        );
    const { mime, ext } = sniffImageMime(buf);
    const { path: savedPath } = saveMediaToTemp(buf, ext);
    logger.debug(`image saved: ${savedPath} (${mime})`);
    return { path: savedPath, type: mime };
  } catch (err) {
    logger.error(`image download/decrypt failed: ${String(err)}`);
    return null;
  }
}

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".tsv",
  ".log",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".ini",
  ".toml",
]);

const EXTENSION_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

/** Guess a MIME type from a file name (best-effort). */
export function inferMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain";
  return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

function sanitizeExt(ext: string): string {
  return ext.replace(/[^\w.]/g, "").slice(0, 12);
}

/**
 * Download + decrypt an inbound FILE item. Returns media info (with the original
 * name and an inferred MIME type), or null when unavailable.
 */
export async function downloadFileFromItem(
  item: MessageItem,
  cdnBaseUrl: string,
): Promise<InboundMedia | null> {
  if (item.type !== MessageItemType.FILE) return null;
  const file = item.file_item;
  const media = file?.media;
  if (!media?.encrypt_query_param && !media?.full_url) return null;

  const name = file?.file_name?.trim() || "file.bin";
  const ext = sanitizeExt(path.extname(name)) || ".bin";
  try {
    const buf = media.aes_key
      ? await downloadAndDecryptBuffer(
          media.encrypt_query_param ?? "",
          media.aes_key,
          cdnBaseUrl,
          "file",
          media.full_url,
        )
      : await downloadPlainCdnBuffer(media.encrypt_query_param ?? "", cdnBaseUrl, "file-plain", media.full_url);
    const { path: savedPath } = saveMediaToTemp(buf, ext);
    logger.debug(`file saved: ${savedPath} (${name})`);
    return { path: savedPath, type: inferMimeType(name), fileName: name };
  } catch (err) {
    logger.error(`file download/decrypt failed: ${String(err)}`);
    return null;
  }
}
