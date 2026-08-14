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
    const { path: savedPath } = saveMediaToTemp(buf, ".jpg");
    logger.debug(`image saved: ${savedPath}`);
    return { path: savedPath, type: "image/*" };
  } catch (err) {
    logger.error(`image download/decrypt failed: ${String(err)}`);
    return null;
  }
}
