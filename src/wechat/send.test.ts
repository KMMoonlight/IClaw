import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("./api.js", () => ({ sendMessage }));

import { chunkText, sendFileMessage, sendImageMessage, sendTextChunked, sendTextMessage } from "./send.js";
import type { UploadedFileInfo } from "./upload.js";
import { resetConfigCache } from "../config.js";

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue(undefined);
});

describe("chunkText", () => {
  it("returns [] for blank input and the original for short input", () => {
    expect(chunkText("", 100)).toEqual([]);
    expect(chunkText("   ", 100)).toEqual([]);
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });

  it("never exceeds the limit and preserves all characters", () => {
    const text = "第一段。第二段！第三段？".repeat(40);
    const chunks = chunkText(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(20);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers paragraph boundaries", () => {
    const text = `${"A".repeat(8)}\n\n${"B".repeat(20)}`;
    const chunks = chunkText(text, 10);
    expect(chunks[0]).toBe("A".repeat(8));
  });

  it("prefers sentence boundaries", () => {
    const text = `${"甲".repeat(8)}。${"乙".repeat(20)}`;
    const chunks = chunkText(text, 12);
    expect(chunks[0]).toBe(`${"甲".repeat(8)}。`);
  });

  it("hard-splits text with no natural boundary", () => {
    const chunks = chunkText("x".repeat(25), 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});

describe("sendTextChunked", () => {
  it("sends one downstream message per chunk and returns their ids", async () => {
    const ids = await sendTextChunked({ to: "wx-user", text: "y".repeat(25), opts: { baseUrl: "b" }, limit: 10 });
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(ids).toHaveLength(3);
    const first = sendMessage.mock.calls[0]![0] as { body: { msg: { item_list: Array<{ text_item: { text: string } }> } } };
    expect(first.body.msg.item_list[0]!.text_item.text).toBe("y".repeat(10));
  });

  it("sends nothing for blank text", async () => {
    await sendTextChunked({ to: "u", text: "   ", opts: { baseUrl: "b" }, limit: 10 });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

const uploadedInfo: UploadedFileInfo = {
  filekey: "fk",
  downloadEncryptedQueryParam: "dq",
  aeskey: "00112233445566778899aabbccddeeff",
  fileSize: 10,
  fileSizeCiphertext: 16,
};

function itemsOf(callIndex: number): Array<Record<string, unknown>> {
  const call = sendMessage.mock.calls[callIndex]![0] as { body: { msg: { item_list: Array<Record<string, unknown>> } } };
  return call.body.msg.item_list;
}

describe("sendImageMessage", () => {
  it("builds an IMAGE item with the CDN ref and base64 key", async () => {
    await sendImageMessage({ to: "u", uploaded: uploadedInfo, opts: { baseUrl: "b", contextToken: "ct" } });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const item = itemsOf(0)[0]!;
    expect(item.type).toBe(2);
    const media = (item.image_item as { media: Record<string, unknown> }).media;
    expect(media.encrypt_query_param).toBe("dq");
    expect(media.aes_key).toBe(Buffer.from(uploadedInfo.aeskey).toString("base64"));
    expect(media.encrypt_type).toBe(1);
    expect((item.image_item as { mid_size: number }).mid_size).toBe(16);
  });

  it("sends a caption as a separate TEXT message first", async () => {
    await sendImageMessage({ to: "u", text: "给你看", uploaded: uploadedInfo, opts: { baseUrl: "b" } });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(itemsOf(0)[0]!.type).toBe(1);
    expect((itemsOf(0)[0]!.text_item as { text: string }).text).toBe("给你看");
    expect(itemsOf(1)[0]!.type).toBe(2);
  });
});

describe("sendFileMessage", () => {
  it("builds a FILE item with name and plaintext length", async () => {
    await sendFileMessage({ to: "u", fileName: "report.pdf", uploaded: uploadedInfo, opts: { baseUrl: "b" } });
    const item = itemsOf(0)[0]!;
    expect(item.type).toBe(4);
    const file = item.file_item as { file_name: string; len: string; media: Record<string, unknown> };
    expect(file.file_name).toBe("report.pdf");
    expect(file.len).toBe("10");
    expect(file.media.encrypt_query_param).toBe("dq");
  });
});

describe("outbound retry", () => {
  it("retries a failing send and reuses the same client_id", async () => {
    sendMessage.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(undefined);
    await sendTextMessage({ to: "u", text: "hi", opts: { baseUrl: "b" } });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const first = (sendMessage.mock.calls[0]![0] as { body: { msg: { client_id: string } } }).body.msg.client_id;
    const second = (sendMessage.mock.calls[1]![0] as { body: { msg: { client_id: string } } }).body.msg.client_id;
    expect(first).toBe(second);
  });

  it("gives up after the configured attempts", async () => {
    sendMessage.mockRejectedValue(new Error("down"));
    await expect(sendTextMessage({ to: "u", text: "x", opts: { baseUrl: "b" } })).rejects.toThrow("down");
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });
});

describe("outbound moderation at the send boundary", () => {
  it("replaces blocked text before sending", async () => {
    process.env.ICLAW_OUTBOUND_BLOCKLIST = "badword";
    resetConfigCache();
    try {
      await sendTextMessage({ to: "u", text: "say badword", opts: { baseUrl: "b" } });
      const sent = (sendMessage.mock.calls[0]![0] as { body: { msg: { item_list: Array<{ text_item: { text: string } }> } } })
        .body.msg.item_list[0]!.text_item.text;
      expect(sent).toBe("抱歉，这条内容不适合发送。");
    } finally {
      delete process.env.ICLAW_OUTBOUND_BLOCKLIST;
      resetConfigCache();
    }
  });
});
