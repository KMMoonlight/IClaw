// Adapted from Tencent/openclaw-weixin (MIT License). See docs/THIRD_PARTY_NOTICES.md.
import type { MessageItem, WeixinMessage } from "./types.js";
import { MessageItemType } from "./types.js";

export interface InboundMedia {
  /** Local path to decrypted media (image/voice/file/video after CDN download+decrypt). */
  path: string;
  /** MIME type hint, e.g. "image/*". */
  type: string;
  /** Original file name for FILE items. */
  fileName?: string;
}

/** Normalized inbound message handed to the agent adapter. */
export interface InboundContext {
  body: string;
  /** The sender's Weixin id (ends with @im.wechat). */
  from: string;
  accountId: string;
  contextToken?: string;
  runId?: string;
  media?: InboundMedia;
  timestamp?: number;
}

export function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  );
}

/** Extract a human-readable text body from the message item list. */
export function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    // 语音转文字
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

/** Find the first image item in the list (for inbound image handling). */
export function findImageItem(itemList?: MessageItem[]): MessageItem | undefined {
  return itemList?.find((i) => i.type === MessageItemType.IMAGE);
}

/** Find the first media item (image/file/voice/video). */
export function findMediaItem(itemList?: MessageItem[]): MessageItem | undefined {
  return itemList?.find((i) => isMediaItem(i));
}

/** Whether media can be sent to the model as an image input. */
export function isImageMedia(media: InboundMedia): boolean {
  return media.type.startsWith("image/");
}

/** Human-readable note describing a non-image attachment for the model. */
export function buildMediaNote(media: InboundMedia, sizeBytes?: number): string {
  const name = media.fileName ?? "附件";
  const size = sizeBytes !== undefined ? `，${sizeBytes} 字节` : "";
  return `[收到附件：${name}${size}，已保存到服务器。]`;
}

/** Convert a WeixinMessage to a normalized InboundContext. */
export function weixinMessageToContext(
  msg: WeixinMessage,
  accountId: string,
  media?: InboundMedia,
): InboundContext {
  const from = msg.from_user_id ?? "";
  const ctx: InboundContext = {
    body: bodyFromItemList(msg.item_list),
    from,
    accountId,
    timestamp: msg.create_time_ms,
  };
  if (msg.context_token) ctx.contextToken = msg.context_token;
  if (msg.run_id) ctx.runId = msg.run_id;
  if (media) ctx.media = media;
  return ctx;
}
