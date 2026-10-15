import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { getUploadUrl } = vi.hoisted(() => ({ getUploadUrl: vi.fn() }));
vi.mock("./api.js", () => ({ getUploadUrl }));

import { aesEcbPaddedSize } from "./cdn/aes-ecb.js";
import { uploadFileAttachmentToWeixin, uploadImageToWeixin } from "./upload.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-upload-test-"));
const filePath = path.join(dir, "pic.png");
const content = Buffer.from("fake-png-bytes");
fs.writeFileSync(filePath, content);

const OK_FETCH = () =>
  vi.fn().mockResolvedValue(new Response("", { status: 200, headers: { "x-encrypted-param": "dl" } })) as unknown as typeof fetch;

beforeEach(() => {
  getUploadUrl.mockReset();
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("uploadMediaToCdn", () => {
  it("requests an upload URL with the right metadata and returns CDN info", async () => {
    getUploadUrl.mockResolvedValue({ upload_param: "up" });
    const fetchImpl = OK_FETCH();
    const info = await uploadImageToWeixin({
      filePath,
      toUserId: "wx-user",
      opts: { baseUrl: "https://gw", token: "tok" },
      cdnBaseUrl: "https://cdn",
      fetchImpl,
    });

    const arg = getUploadUrl.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.baseUrl).toBe("https://gw");
    expect(arg.token).toBe("tok");
    expect(arg.to_user_id).toBe("wx-user");
    expect(arg.media_type).toBe(1); // UploadMediaType.IMAGE
    expect(arg.rawsize).toBe(content.length);
    expect(arg.filesize).toBe(aesEcbPaddedSize(content.length));
    expect(arg.rawfilemd5).toBe(crypto.createHash("md5").update(content).digest("hex"));
    expect(arg.no_need_thumb).toBe(true);
    expect(String(arg.filekey)).toMatch(/^[0-9a-f]{32}$/);
    expect(String(arg.aeskey)).toMatch(/^[0-9a-f]{32}$/);

    expect(info.downloadEncryptedQueryParam).toBe("dl");
    expect(info.fileSize).toBe(content.length);
    expect(info.fileSizeCiphertext).toBe(aesEcbPaddedSize(content.length));
    expect(info.aeskey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("uses media_type FILE for attachments", async () => {
    getUploadUrl.mockResolvedValue({ upload_param: "up" });
    await uploadFileAttachmentToWeixin({
      filePath,
      toUserId: "u",
      opts: { baseUrl: "b", token: "t" },
      cdnBaseUrl: "https://cdn",
      fetchImpl: OK_FETCH(),
    });
    expect((getUploadUrl.mock.calls[0]![0] as Record<string, unknown>).media_type).toBe(3);
  });

  it("throws when getUploadUrl returns no upload target", async () => {
    getUploadUrl.mockResolvedValue({});
    await expect(
      uploadImageToWeixin({ filePath, toUserId: "u", opts: { baseUrl: "b", token: "t" }, cdnBaseUrl: "https://cdn", fetchImpl: OK_FETCH() }),
    ).rejects.toThrow("no upload URL");
  });
});
