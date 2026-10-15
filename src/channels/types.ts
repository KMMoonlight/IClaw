import type { InboundMedia } from "../wechat/inbound.js";

/** A channel-agnostic inbound message. */
export interface InboundMessage {
  /** Channel identifier, e.g. "wechat" / "web". */
  channelId: string;
  /** Channel-specific account that received the message. */
  accountId: string;
  /** Channel-specific sender id. */
  senderId: string;
  text: string;
  media?: InboundMedia;
  contextToken?: string;
}

/** How a handler sends replies back through a channel. */
export interface ReplySink {
  text: (text: string) => Promise<void>;
  /** Optional typing indicator (no-op for channels that lack one). */
  startTyping?: () => Promise<void>;
  stopTyping?: () => Promise<void>;
}

/** The transport-agnostic handler contract: any channel can drive this. */
export type MessageHandler = (message: InboundMessage, reply: ReplySink) => Promise<void>;

/** A transport that delivers inbound messages to a {@link MessageHandler}. */
export interface Channel {
  readonly id: string;
  start(handler: MessageHandler): void;
  stop(): void;
}
