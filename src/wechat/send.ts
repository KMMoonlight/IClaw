// Adapted from Tencent/openclaw-weixin (MIT License). See docs/THIRD_PARTY_NOTICES.md.
import { loadConfig } from "../config.js";
import { sendMessage as sendMessageApi } from "./api.js";
import type { WeixinApiOptions } from "./api.js";
import { generateId } from "../random.js";
import { applyOutboundModeration } from "../moderation.js";
import type { MessageItem, SendMessageReq } from "./types.js";
import { MessageItemType, MessageState, MessageType } from "./types.js";
import type { UploadedFileInfo } from "./upload.js";

export type SendTextOptions = WeixinApiOptions & {
  contextToken?: string;
  runId?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an outbound send. The caller's `client_id` is generated once and reused
 * across attempts so the gateway can de-duplicate a retried message.
 */
async function sendWithRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(100 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string;
  runId?: string;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, runId, clientId } = params;
  const item_list: MessageItem[] = text
    ? [{ type: MessageItemType.TEXT, text_item: { text } }]
    : [];
  return {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: item_list.length ? item_list : undefined,
      context_token: contextToken ?? undefined,
      run_id: runId ?? undefined,
    },
  };
}

/** Send a plain text message downstream. */
export async function sendTextMessage(params: {
  to: string;
  text: string;
  opts: SendTextOptions;
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  const clientId = generateId("iclaw");
  const req = buildTextMessageReq({ to, text: applyOutboundModeration(text), contextToken: opts.contextToken, runId: opts.runId, clientId });
  const attempts = Math.max(1, loadConfig().sendRetries + 1);
  await sendWithRetry(
    () => sendMessageApi({ baseUrl: opts.baseUrl, token: opts.token, timeoutMs: opts.timeoutMs, body: req }),
    attempts,
  );
  return { messageId: clientId };
}

/** Candidate split points, ordered by preference (most to least preferred). */
const BREAK_SEGMENTS: string[] = ["\n\n", "\n", "。", "！", "？", "；", "…", ". ", "! ", "? ", "; "];

/** Choose a cut offset (`<= limit`) at a natural boundary, or hard-cut at the limit. */
function findCut(window: string, limit: number): number {
  const min = Math.floor(limit * 0.5);
  let bestIdx = -1;
  let bestEnd = limit;
  for (const seg of BREAK_SEGMENTS) {
    const idx = window.lastIndexOf(seg);
    if (idx >= min && idx > bestIdx) {
      bestIdx = idx;
      bestEnd = Math.min(limit, idx + seg.length);
    }
  }
  return bestEnd > 0 ? bestEnd : limit;
}

/**
 * Split text into chunks no longer than `limit` characters, preferring paragraph
 * / sentence boundaries. Returns [] for blank input.
 */
export function chunkText(text: string, limit: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const max = Math.max(1, Math.floor(limit));
  if (trimmed.length <= max) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > max) {
    const window = remaining.slice(0, max);
    const cut = findCut(window, max);
    const piece = remaining.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Send text, splitting into multiple messages when it exceeds the chunk limit
 * (ICLAW_SEND_CHUNK_CHARS). Messages are sent sequentially to preserve order.
 */
export async function sendTextChunked(params: {
  to: string;
  text: string;
  opts: SendTextOptions;
  limit?: number;
}): Promise<string[]> {
  const limit = params.limit ?? loadConfig().sendChunkChars;
  const chunks = chunkText(params.text, limit);
  const ids: string[] = [];
  for (const chunk of chunks) {
    const { messageId } = await sendTextMessage({ to: params.to, text: chunk, opts: params.opts });
    ids.push(messageId);
  }
  return ids;
}

/** Send a single item as its own request (item_list always has one entry). */
async function sendSingleItem(params: { to: string; item: MessageItem; opts: SendTextOptions }): Promise<string> {
  const clientId = generateId("iclaw");
  const req: SendMessageReq = {
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [params.item],
      context_token: params.opts.contextToken ?? undefined,
      run_id: params.opts.runId ?? undefined,
    },
  };
  const attempts = Math.max(1, loadConfig().sendRetries + 1);
  await sendWithRetry(
    () => sendMessageApi({ baseUrl: params.opts.baseUrl, token: params.opts.token, timeoutMs: params.opts.timeoutMs, body: req }),
    attempts,
  );
  return clientId;
}

/** Send an optional text caption (as its own message) followed by a media item. */
async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: SendTextOptions;
}): Promise<{ messageId: string }> {
  let last = "";
  if (params.text) {
    last = await sendSingleItem({
      to: params.to,
      item: { type: MessageItemType.TEXT, text_item: { text: applyOutboundModeration(params.text) } },
      opts: params.opts,
    });
  }
  last = await sendSingleItem({ to: params.to, item: params.mediaItem, opts: params.opts });
  return { messageId: last };
}

const mediaRef = (uploaded: UploadedFileInfo) => ({
  encrypt_query_param: uploaded.downloadEncryptedQueryParam,
  // aeskey is hex-encoded; the wire format carries base64 of that string.
  aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
  encrypt_type: 1,
});

/** Send an image message using a previously uploaded file. */
export function sendImageMessage(params: {
  to: string;
  text?: string;
  uploaded: UploadedFileInfo;
  opts: SendTextOptions;
}): Promise<{ messageId: string }> {
  const item: MessageItem = {
    type: MessageItemType.IMAGE,
    image_item: { media: mediaRef(params.uploaded), mid_size: params.uploaded.fileSizeCiphertext },
  };
  return sendMediaItems({ to: params.to, text: params.text ?? "", mediaItem: item, opts: params.opts });
}

/** Send a video message using a previously uploaded file. */
export function sendVideoMessage(params: {
  to: string;
  text?: string;
  uploaded: UploadedFileInfo;
  opts: SendTextOptions;
}): Promise<{ messageId: string }> {
  const item: MessageItem = {
    type: MessageItemType.VIDEO,
    video_item: { media: mediaRef(params.uploaded), video_size: params.uploaded.fileSizeCiphertext },
  };
  return sendMediaItems({ to: params.to, text: params.text ?? "", mediaItem: item, opts: params.opts });
}

/** Send a file attachment using a previously uploaded file. */
export function sendFileMessage(params: {
  to: string;
  text?: string;
  fileName: string;
  uploaded: UploadedFileInfo;
  opts: SendTextOptions;
}): Promise<{ messageId: string }> {
  const item: MessageItem = {
    type: MessageItemType.FILE,
    file_item: {
      media: mediaRef(params.uploaded),
      file_name: params.fileName,
      len: String(params.uploaded.fileSize),
    },
  };
  return sendMediaItems({ to: params.to, text: params.text ?? "", mediaItem: item, opts: params.opts });
}
