import { beforeEach, describe, expect, it } from "vitest";

import { createMemoryChannel } from "./memory.js";
import {
  getChannel,
  listChannels,
  registerChannel,
  resetChannels,
  startChannel,
  stopAllRegisteredChannels,
} from "./registry.js";

beforeEach(() => resetChannels());

describe("channel registry", () => {
  it("registers, starts and drives a second channel without touching the agent core", async () => {
    const channel = createMemoryChannel("mem");
    registerChannel(channel);
    expect(listChannels()).toEqual(["mem"]);
    expect(getChannel("mem")).toBe(channel);
    expect(startChannel("mem", async (message, reply) => reply.text(`echo:${message.text}`))).toBe(true);

    expect(await channel.send({ accountId: "a", senderId: "s", text: "hi" })).toEqual(["echo:hi"]);

    stopAllRegisteredChannels();
    await expect(channel.send({ accountId: "a", senderId: "s", text: "x" })).rejects.toThrow("not started");
  });

  it("returns false for an unknown channel", () => {
    expect(startChannel("missing", async () => {})).toBe(false);
  });
});
