import path from "node:path";

import type { WeixinApiOptions } from "./api.js";
import { inferMimeType } from "./media-download.js";
import { sendFileMessage, sendImageMessage, sendVideoMessage } from "./send.js";
import type { SendTextOptions } from "./send.js";
import { uploadFileAttachmentToWeixin, uploadImageToWeixin, uploadVideoToWeixin } from "./upload.js";

export interface SendMediaParams {
  filePath: string;
  to: string;
  text?: string;
  opts: SendTextOptions;
  cdnBaseUrl: string;
  /** Injectable fetch for the CDN upload (tests). */
  fetchImpl?: typeof fetch;
}

export interface SendMediaResult {
  messageId: string;
  kind: "image" | "video" | "file";
}

/**
 * Upload a local file and send it, routing by MIME type:
 *   image/*  → image upload + image message
 *   video/*  → video upload + video message
 *   else     → file attachment upload + file message
 * An optional `text` is sent first as a caption.
 */
export async function sendMediaFile(params: SendMediaParams): Promise<SendMediaResult> {
  const { filePath, to, text = "", opts, cdnBaseUrl } = params;
  const uploadOpts: WeixinApiOptions = { baseUrl: opts.baseUrl, token: opts.token };
  const mime = inferMimeType(filePath);

  if (mime.startsWith("image/")) {
    const uploaded = await uploadImageToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
      fetchImpl: params.fetchImpl,
    });
    const { messageId } = await sendImageMessage({ to, text, uploaded, opts });
    return { messageId, kind: "image" };
  }

  if (mime.startsWith("video/")) {
    const uploaded = await uploadVideoToWeixin({
      filePath,
      toUserId: to,
      opts: uploadOpts,
      cdnBaseUrl,
      fetchImpl: params.fetchImpl,
    });
    const { messageId } = await sendVideoMessage({ to, text, uploaded, opts });
    return { messageId, kind: "video" };
  }

  const uploaded = await uploadFileAttachmentToWeixin({
    filePath,
    toUserId: to,
    opts: uploadOpts,
    cdnBaseUrl,
    fetchImpl: params.fetchImpl,
  });
  const { messageId } = await sendFileMessage({ to, text, fileName: path.basename(filePath), uploaded, opts });
  return { messageId, kind: "file" };
}
