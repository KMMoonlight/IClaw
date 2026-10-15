import type { Channel, MessageHandler } from "./types.js";
import type { InboundMedia } from "../wechat/inbound.js";

export interface MemoryChannelInput {
  accountId: string;
  senderId: string;
  text: string;
  media?: InboundMedia;
  contextToken?: string;
}

export interface MemoryChannel extends Channel {
  /** Simulate an inbound message; resolves with the replies it produced. */
  send(input: MemoryChannelInput): Promise<string[]>;
}

/**
 * In-memory channel used in tests and local development. It exists to prove
 * that a second transport can drive the agent gateway without touching the
 * agent core.
 */
export function createMemoryChannel(id = "memory"): MemoryChannel {
  let handler: MessageHandler | null = null;
  return {
    id,
    start(next: MessageHandler): void {
      handler = next;
    },
    stop(): void {
      handler = null;
    },
    async send(input: MemoryChannelInput): Promise<string[]> {
      if (!handler) throw new Error(`channel ${id} is not started`);
      const outbox: string[] = [];
      const reply = {
        text: async (text: string): Promise<void> => {
          outbox.push(text);
        },
      };
      await handler(
        {
          channelId: id,
          accountId: input.accountId,
          senderId: input.senderId,
          text: input.text,
          media: input.media,
          contextToken: input.contextToken,
        },
        reply,
      );
      return outbox;
    },
  };
}
