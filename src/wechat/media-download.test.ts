import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetConfigCache } from "../config.js";
import { downloadFileFromItem, inferMimeType, sniffImageMime } from "./media-download.js";
import { MessageItemType } from "./types.js";
import type { MessageItem } from "./types.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-media-test-"));
const orig = process.env.ICLAW_STATE_DIR;

beforeEach(() => {
  process.env.ICLAW_STATE_DIR = stateDir;
  resetConfigCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetConfigCache();
});

afterAll(() => {
  if (orig === undefined) delete process.env.ICLAW_STATE_DIR;
  else process.env.ICLAW_STATE_DIR = orig;
  resetConfigCache();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("inferMimeType", () => {
  it("maps common extensions", () => {
    expect(inferMimeType("notes.txt")).toBe("text/plain");
    expect(inferMimeType("data.json")).toBe("text/plain");
    expect(inferMimeType("doc.pdf")).toBe("application/pdf");
    expect(inferMimeType("pic.png")).toBe("image/png");
    expect(inferMimeType("archive.zip")).toBe("application/zip");
    expect(inferMimeType("clip.mp4")).toBe("video/mp4");
    expect(inferMimeType("noext")).toBe("application/octet-stream");
    expect(inferMimeType("weird.xyz")).toBe("application/octet-stream");
  });
});

function fileItem(overrides: Partial<{ fileName: string; fullUrl: string; query: string; aesKey: string }>): MessageItem {
  return {
    type: MessageItemType.FILE,
    file_item: {
      file_name: overrides.fileName ?? "notes.txt",
      media: {
        full_url: overrides.fullUrl,
        encrypt_query_param: overrides.query ?? "q",
        aes_key: overrides.aesKey,
      },
    },
  };
}

describe("sniffImageMime", () => {
  it("detects common image formats from magic bytes", () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ mime: "image/png", ext: ".png" });
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ mime: "image/jpeg", ext: ".jpg" });
    expect(sniffImageMime(Buffer.from("GIF89a", "ascii"))).toEqual({ mime: "image/gif", ext: ".gif" });
    expect(sniffImageMime(Buffer.from("RIFF____WEBPVP8 ", "ascii"))).toEqual({ mime: "image/webp", ext: ".webp" });
  });

  it("falls back to jpeg for unknown bytes", () => {
    expect(sniffImageMime(Buffer.from("nope"))).toEqual({ mime: "image/jpeg", ext: ".jpg" });
  });
});

describe("downloadFileFromItem", () => {
  it("ignores non-file items", async () => {
    expect(await downloadFileFromItem({ type: MessageItemType.IMAGE }, "https://cdn")).toBeNull();
  });

  it("ignores file items with no CDN reference", async () => {
    const item: MessageItem = { type: MessageItemType.FILE, file_item: { file_name: "x" } };
    expect(await downloadFileFromItem(item, "https://cdn")).toBeNull();
  });

  it("downloads a plain (unencrypted) file and returns its name + mime type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("file-body", { status: 200 })),
    );
    const media = await downloadFileFromItem(fileItem({ fullUrl: "https://cdn.example/f" }), "https://cdn");
    expect(media).not.toBeNull();
    expect(media!.fileName).toBe("notes.txt");
    expect(media!.type).toBe("text/plain");
    expect(fs.readFileSync(media!.path, "utf-8")).toBe("file-body");
  });

  it("returns null when the download fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    expect(await downloadFileFromItem(fileItem({ fullUrl: "https://cdn.example/f" }), "https://cdn")).toBeNull();
  });
});
