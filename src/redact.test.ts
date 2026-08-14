import { describe, expect, it } from "vitest";

import { redactBody, redactToken, redactUrl } from "./redact.js";

describe("redactToken", () => {
  it("returns empty for missing tokens", () => {
    expect(redactToken(undefined)).toBe("");
    expect(redactToken(null)).toBe("");
    expect(redactToken("")).toBe("");
  });

  it("masks short tokens completely", () => {
    expect(redactToken("abc123")).toBe("***");
  });

  it("keeps only the head/tail of long tokens", () => {
    expect(redactToken("abcdefgh12345678")).toBe("abcd...5678");
  });
});

describe("redactBody", () => {
  it("masks Authorization, bot_token and aes keys in JSON", () => {
    const raw = JSON.stringify({
      Authorization: "Bearer supersecret",
      bot_token: "bt-secret",
      aes_key: "aes-secret",
      aeskey: "aeskey-secret",
      plain: "visible",
    });
    const out = redactBody(raw);
    expect(out).not.toContain("supersecret");
    expect(out).not.toContain("bt-secret");
    expect(out).not.toContain("aes-secret");
    expect(out).not.toContain("aeskey-secret");
    expect(out).toContain("visible");
  });

  it("is case-insensitive and returns non-string input as-is", () => {
    expect(redactBody("")).toBe("");
    expect(redactBody('{"authorization":"Bearer xyz"}')).toContain("***");
  });
});

describe("redactUrl", () => {
  it("masks sensitive query params", () => {
    const url = "https://example.com/path?qrcode=secret&verify_code=123&other=keep";
    const out = redactUrl(url);
    expect(out).not.toContain("secret");
    expect(out).not.toContain("123");
    expect(out).toContain("other=keep");
  });

  it("returns unparseable input unchanged", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });
});
