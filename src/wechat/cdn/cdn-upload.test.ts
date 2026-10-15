import { describe, expect, it, vi } from "vitest";

import { aesEcbPaddedSize } from "./aes-ecb.js";
import { uploadBufferToCdn } from "./cdn-upload.js";

const AESKEY = Buffer.alloc(16, 7);
const BUF = Buffer.from("hello media");

function fetchReturning(headers: Record<string, string>, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(new Response("", { status, headers })) as unknown as typeof fetch;
}

describe("uploadBufferToCdn", () => {
  it("uploads the encrypted body and reads x-encrypted-param", async () => {
    const fetchImpl = fetchReturning({ "x-encrypted-param": "download-param" });
    const result = await uploadBufferToCdn({
      buf: BUF,
      uploadParam: "up-param",
      filekey: "fk",
      cdnBaseUrl: "https://cdn.example/c2c",
      aeskey: AESKEY,
      label: "test",
      fetchImpl,
    });
    expect(result.downloadParam).toBe("download-param");

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("https://cdn.example/c2c/upload?encrypted_query_param=up-param&filekey=fk");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");
    // Body is the AES-128-ECB ciphertext (PKCS7 padded).
    expect((init.body as Uint8Array).byteLength).toBe(aesEcbPaddedSize(BUF.length));
  });

  it("prefers upload_full_url over the built URL", async () => {
    const fetchImpl = fetchReturning({ "x-encrypted-param": "d" });
    await uploadBufferToCdn({
      buf: BUF,
      uploadFullUrl: "https://upload.example/full",
      uploadParam: "ignored",
      filekey: "fk",
      cdnBaseUrl: "https://cdn.example",
      aeskey: AESKEY,
      label: "test",
      fetchImpl,
    });
    expect((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]).toBe(
      "https://upload.example/full",
    );
  });

  it("throws when no upload URL is provided", async () => {
    await expect(
      uploadBufferToCdn({ buf: BUF, filekey: "fk", cdnBaseUrl: "https://cdn", aeskey: AESKEY, label: "test" }),
    ).rejects.toThrow("upload URL missing");
  });

  it("aborts immediately on a 4xx client error", async () => {
    const fetchImpl = fetchReturning({ "x-error-message": "bad request" }, 400);
    await expect(
      uploadBufferToCdn({ buf: BUF, uploadParam: "p", filekey: "fk", cdnBaseUrl: "https://cdn", aeskey: AESKEY, label: "t", fetchImpl }),
    ).rejects.toThrow("client error 400");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries server errors and eventually succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 200, headers: { "x-encrypted-param": "ok" } })) as unknown as typeof fetch;
    const result = await uploadBufferToCdn({
      buf: BUF,
      uploadParam: "p",
      filekey: "fk",
      cdnBaseUrl: "https://cdn",
      aeskey: AESKEY,
      label: "t",
      fetchImpl,
    });
    expect(result.downloadParam).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails after exhausting retries when the header is missing", async () => {
    const fetchImpl = fetchReturning({});
    await expect(
      uploadBufferToCdn({ buf: BUF, uploadParam: "p", filekey: "fk", cdnBaseUrl: "https://cdn", aeskey: AESKEY, label: "t", fetchImpl }),
    ).rejects.toThrow("x-encrypted-param");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
