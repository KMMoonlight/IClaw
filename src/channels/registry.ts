import type { Channel, MessageHandler } from "./types.js";

const channels = new Map<string, Channel>();

/** Register a transport so it can be started/stopped by id. */
export function registerChannel(channel: Channel): void {
  channels.set(channel.id, channel);
}

export function getChannel(id: string): Channel | undefined {
  return channels.get(id);
}

export function listChannels(): string[] {
  return [...channels.keys()];
}

/** Start a registered channel, wiring it to the shared message handler. */
export function startChannel(id: string, handler: MessageHandler): boolean {
  const channel = channels.get(id);
  if (!channel) return false;
  channel.start(handler);
  return true;
}

export function stopChannel(id: string): void {
  channels.get(id)?.stop();
}

export function stopAllRegisteredChannels(): void {
  for (const channel of channels.values()) channel.stop();
}

/** Clear the registry (tests). */
export function resetChannels(): void {
  stopAllRegisteredChannels();
  channels.clear();
}
