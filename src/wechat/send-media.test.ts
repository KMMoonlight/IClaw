import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendImageMessage, sendVideoMessage, sendFileMessage, uploadImageToWeixin, uploadVideoToWeixin, uploadFileAttachmentToWeixin } =
  vi.hoisted(() => ({
    sendImageMessage: vi.fn(),
    sendVideoMessage: vi.fn(),
    sendFileMessage: vi.fn(),
    uploadImageToWeixin: vi.fn(),
    uploadVideoToWeixin: vi.fn(),
    uploadFileAttachmentToWeixin: vi.fn(),
  }));

vi.mock("./send.js", () => ({ sendImageMessage, sendVideoMessage, sendFileMessage }));
vi.mock("./upload.js", () => ({ uploadImageToWeixin, uploadVideoToWeixin, uploadFileAttachmentToWeixin }));

import { sendMediaFile } from "./send-media.js";

const uploaded = {
  filekey: "fk",
  downloadEncryptedQueryParam: "dq",
  aeskey: "00".repeat(16),
  fileSize: 1,
  fileSizeCiphertext: 16,
};

beforeEach(() => {
  for (const fn of [sendImageMessage, sendVideoMessage, sendFileMessage]) fn.mockReset().mockResolvedValue({ messageId: "m1" });
  for (const fn of [uploadImageToWeixin, uploadVideoToWeixin, uploadFileAttachmentToWeixin]) fn.mockReset().mockResolvedValue(uploaded);
});

const base = { to: "wx-user", opts: { baseUrl: "https://gw", token: "tok", contextToken: "ct" }, cdnBaseUrl: "https://cdn" };

describe("sendMediaFile", () => {
  it("routes images through the image uploader + sender", async () => {
    const result = await sendMediaFile({ ...base, filePath: "/ws/pic.PNG", text: "cap" });
    expect(result.kind).toBe("image");
    expect(uploadImageToWeixin).toHaveBeenCalledTimes(1);
    expect(sendImageMessage).toHaveBeenCalledWith(expect.objectContaining({ to: "wx-user", text: "cap", uploaded }));
    expect(uploadVideoToWeixin).not.toHaveBeenCalled();
  });

  it("routes videos through the video path", async () => {
    const result = await sendMediaFile({ ...base, filePath: "/ws/clip.mp4" });
    expect(result.kind).toBe("video");
    expect(sendVideoMessage).toHaveBeenCalled();
  });

  it("routes everything else as a file attachment with its basename", async () => {
    const result = await sendMediaFile({ ...base, filePath: "/ws/report.pdf" });
    expect(result.kind).toBe("file");
    expect(sendFileMessage).toHaveBeenCalledWith(expect.objectContaining({ fileName: "report.pdf", uploaded }));
  });
});
