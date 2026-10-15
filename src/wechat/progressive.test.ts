import { describe, expect, it } from "vitest";

import { ProgressiveSender } from "./progressive.js";

function collector(): { sent: string[]; send: (t: string) => Promise<void> } {
  const sent: string[] = [];
  return { sent, send: async (t: string) => void sent.push(t) };
}

describe("ProgressiveSender", () => {
  it("sends the fallback reply when nothing was streamed", async () => {
    const { sent, send } = collector();
    const p = new ProgressiveSender(send, 10);
    expect(p.streamed).toBe(false);
    await p.finish("完整回复");
    expect(sent).toEqual(["完整回复"]);
  });

  it("flushes streamed text and never duplicates the fallback reply", async () => {
    const { sent, send } = collector();
    const p = new ProgressiveSender(send, 10);
    p.push("你好");
    await p.finish("你好（完整）");
    expect(sent).toEqual(["你好"]);
  });

  it("sends in chunks of at least the limit plus a final leftover", async () => {
    const { sent, send } = collector();
    const p = new ProgressiveSender(send, 10);
    p.push("a".repeat(25));
    await p.finish("");
    expect(sent.map((s) => s.length)).toEqual([10, 10, 5]);
  });

  it("ignores empty deltas", async () => {
    const { sent, send } = collector();
    const p = new ProgressiveSender(send, 10);
    p.push("");
    await p.finish("fallback");
    expect(sent).toEqual(["fallback"]);
  });

  it("keeps chunk order under async sends", async () => {
    const { sent } = collector();
    const p = new ProgressiveSender(async (t) => {
      await new Promise((r) => setTimeout(r, t.length === 10 ? 5 : 0));
      sent.push(t);
    }, 10);
    p.push("1234567890" + "ABCDE");
    await p.finish("");
    expect(sent).toEqual(["1234567890", "ABCDE"]);
  });

  it("reset drops buffered text from an abandoned attempt", async () => {
    const { sent, send } = collector();
    const p = new ProgressiveSender(send, 10);
    p.push("失败的");
    p.reset();
    p.push("重试成功");
    await p.finish("重试成功");
    expect(sent).toEqual(["重试成功"]);
  });

  it("swallows send failures without rejecting finish", async () => {
    let calls = 0;
    const p = new ProgressiveSender(async () => {
      calls += 1;
      throw new Error("network");
    }, 5);
    p.push("abcdef");
    await expect(p.finish("x")).resolves.toBeUndefined();
    expect(calls).toBeGreaterThan(0);
  });
});
