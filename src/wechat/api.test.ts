import { describe, expect, it } from "vitest";

import { classifyFetchError, sanitizeBotAgent } from "./api.js";
import { DEFAULT_BOT_AGENT } from "../config.js";

describe("sanitizeBotAgent", () => {
  it("falls back to the default for missing/invalid input", () => {
    expect(sanitizeBotAgent(undefined)).toBe(DEFAULT_BOT_AGENT);
    expect(sanitizeBotAgent("")).toBe(DEFAULT_BOT_AGENT);
    expect(sanitizeBotAgent("bad token!!")).toBe(DEFAULT_BOT_AGENT);
    expect(sanitizeBotAgent("NoSlash")).toBe(DEFAULT_BOT_AGENT);
  });

  it("accepts a product token", () => {
    expect(sanitizeBotAgent("IClaw/1.0")).toBe("IClaw/1.0");
  });

  it("accepts a comment in parentheses", () => {
    expect(sanitizeBotAgent("IClaw/1.0 (+https://example.com/repo)")).toBe(
      "IClaw/1.0 (+https://example.com/repo)",
    );
  });

  it("keeps multiple product tokens", () => {
    expect(sanitizeBotAgent("IClaw/1.0 OtherBot/2.0")).toBe("IClaw/1.0 OtherBot/2.0");
  });

  it("caps total length at 256 bytes", () => {
    const long = Array.from({ length: 40 }, () => "Abcdefghijklmnop/1.0").join(" ");
    const out = sanitizeBotAgent(long);
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(256);
    expect(out.startsWith("Abcdefghijklmnop/1.0")).toBe(true);
  });
});

describe("classifyFetchError", () => {
  it("classifies DNS failures", () => {
    const err = new Error("lookup failed", { cause: { code: "ENOTFOUND" } });
    expect(classifyFetchError(err).type).toBe("dns");
  });

  it("classifies TCP connection refused", () => {
    const err = new Error("refused", { cause: { code: "ECONNREFUSED" } });
    expect(classifyFetchError(err).type).toBe("tcp");
  });

  it("classifies timeouts as tcp", () => {
    const err = new Error("timeout", { cause: { code: "ETIMEDOUT" } });
    expect(classifyFetchError(err).type).toBe("tcp");
  });

  it("classifies aborts as timeout", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(classifyFetchError(err).type).toBe("timeout");
  });

  it("classifies TLS failures", () => {
    const err = new Error("tls", { cause: { code: "CERT_HAS_EXPIRED" } });
    expect(classifyFetchError(err).type).toBe("tls");
  });

  it("defaults to unknown", () => {
    expect(classifyFetchError(new Error("boom")).type).toBe("unknown");
  });
});
