// Adapted from Tencent/openclaw-weixin (MIT License). See docs/THIRD_PARTY_NOTICES.md.
import crypto from "node:crypto";
import fs from "node:fs/promises";

import { getUploadUrl } from "./api.js";
import type { WeixinApiOptions } from "./api.js";
import { aesEcbPaddedSize } from "./cdn/aes-ecb.js";
import { uploadBufferToCdn } from "./cdn/cdn-upload.js";
import { UploadMediaType } from "./types.js";

export interface UploadedFileInfo {
  filekey: string;
  /** Fill into `media.encrypt_query_param` on the outbound item. */
  downloadEncryptedQueryParam: string;
  /** AES-128-ECB key, hex-encoded; base64-encode it for `CDNMedia.aes_key`. */
  aeskey: string;
  /** Plaintext size in bytes. */
  fileSize: number;
  /** Ciphertext size in bytes (AES-128-ECB with PKCS7); use for `mid_size` / `video_size`. */
  fileSizeCiphertext: number;
}

/** Common upload pipeline: read file → hash → gen key → getUploadUrl → uploadBufferToCdn. */
async function uploadMediaToCdn(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
  mediaType: number;
  label: string;
  fetchImpl?: typeof fetch;
}): Promise<UploadedFileInfo> {
  const { filePath, toUserId, opts, cdnBaseUrl, mediaType, label } = params;

  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const uploadUrlResp = await getUploadUrl({
    ...opts,
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error(`${label}: getUploadUrl returned no upload URL`);
  }

  const { downloadParam: downloadEncryptedQueryParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadFullUrl || undefined,
    uploadParam: uploadParam ?? undefined,
    filekey,
    cdnBaseUrl,
    aeskey,
    fetchImpl: params.fetchImpl,
    label: `${label}[filekey=${filekey}]`,
  });

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

/** Upload a local image file to the Weixin CDN. */
export function uploadImageToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({ ...params, mediaType: UploadMediaType.IMAGE, label: "uploadImageToWeixin" });
}

/** Upload a local video file to the Weixin CDN. */
export function uploadVideoToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({ ...params, mediaType: UploadMediaType.VIDEO, label: "uploadVideoToWeixin" });
}

/** Upload a local file attachment (non-image/video) to the Weixin CDN. */
export function uploadFileAttachmentToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinApiOptions;
  cdnBaseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({ ...params, mediaType: UploadMediaType.FILE, label: "uploadFileAttachmentToWeixin" });
}
