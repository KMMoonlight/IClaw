import { describe, expect, it } from "vitest";

import { bodyFromItemList, findImageItem, isMediaItem, weixinMessageToContext } from "./inbound.js";
import { MessageItemType } from "./types.js";
import type { MessageItem, WeixinMessage } from "./types.js";

function textItem(text: string): MessageItem {
  return { type: MessageItemType.TEXT, text_item: { text } };
}

describe("isMediaItem", () => {
  it("classifies media types", () => {
    expect(isMediaItem({ type: MessageItemType.IMAGE })).toBe(true);
    expect(isMediaItem({ type: MessageItemType.VIDEO })).toBe(true);
    expect(isMediaItem({ type: MessageItemType.FILE })).toBe(true);
    expect(isMediaItem({ type: MessageItemType.VOICE })).toBe(true);
    expect(isMediaItem({ type: MessageItemType.TEXT })).toBe(false);
  });
});

describe("bodyFromItemList", () => {
  it("returns empty for missing/empty lists", () => {
    expect(bodyFromItemList(undefined)).toBe("");
    expect(bodyFromItemList([])).toBe("");
  });

  it("extracts plain text", () => {
    expect(bodyFromItemList([textItem("你好")])).toBe("你好");
  });

  it("quotes referenced text messages", () => {
    const item = textItem("回复内容");
    item.ref_msg = { title: "标题", message_item: textItem("原文") };
    expect(bodyFromItemList([item])).toBe("[引用: 标题 | 原文]\n回复内容");
  });

  it("drops the quote for referenced media", () => {
    const item = textItem("看图回复");
    item.ref_msg = { message_item: { type: MessageItemType.IMAGE } };
    expect(bodyFromItemList([item])).toBe("看图回复");
  });

  it("uses voice-to-text when present", () => {
    const item: MessageItem = {
      type: MessageItemType.VOICE,
      voice_item: { text: "语音转文字内容" },
    };
    expect(bodyFromItemList([item])).toBe("语音转文字内容");
  });
});

describe("findImageItem", () => {
  it("finds the first image item", () => {
    const list = [textItem("x"), { type: MessageItemType.IMAGE }, { type: MessageItemType.IMAGE }];
    expect(findImageItem(list)).toBe(list[1]);
    expect(findImageItem([textItem("x")])).toBeUndefined();
  });
});

describe("weixinMessageToContext", () => {
  it("maps message fields into the normalized context", () => {
    const msg: WeixinMessage = {
      from_user_id: "wx@im.wechat",
      create_time_ms: 123,
      context_token: "ct",
      run_id: "run-1",
      item_list: [textItem("hi")],
    };
    const ctx = weixinMessageToContext(msg, "acc1", { path: "/tmp/x.jpg", type: "image/*" });
    expect(ctx.body).toBe("hi");
    expect(ctx.from).toBe("wx@im.wechat");
    expect(ctx.accountId).toBe("acc1");
    expect(ctx.contextToken).toBe("ct");
    expect(ctx.runId).toBe("run-1");
    expect(ctx.timestamp).toBe(123);
    expect(ctx.media?.path).toBe("/tmp/x.jpg");
  });
});
