import { afterEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../config.js";
import { PROVIDERS, resolveBaseUrl, supportsImages } from "./models.js";

const KEY = "ICLAW_MODEL_SUPPORTS_IMAGES";
const saved = process.env[KEY];

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
  resetConfigCache();
});

describe("PROVIDERS", () => {
  it("ships built-in base URLs for known providers", () => {
    expect(PROVIDERS.deepseek?.baseUrl).toBe("https://api.deepseek.com");
    expect(PROVIDERS.anthropic?.api).toBe("anthropic-messages");
    expect(PROVIDERS["openai-responses"]?.api).toBe("openai-responses");
    expect(PROVIDERS["kimi-code"]?.bearerAuth).toBe(true);
  });

  it("defaults unknown providers to openai-completions with an explicit base URL", () => {
    expect(PROVIDERS["some-new-provider"]).toBeUndefined();
    expect(resolveBaseUrl("some-new-provider", "https://custom.example/v1")).toBe("https://custom.example/v1");
    expect(() => resolveBaseUrl("some-new-provider", undefined)).toThrow(/ICLAW_MODEL_BASE_URL/);
  });

  it("lets the override win over built-in URLs", () => {
    expect(resolveBaseUrl("deepseek", "http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
  });
});

describe("supportsImages", () => {
  it("reflects ICLAW_MODEL_SUPPORTS_IMAGES", () => {
    process.env[KEY] = "false";
    resetConfigCache();
    expect(supportsImages()).toBe(false);
    process.env[KEY] = "true";
    resetConfigCache();
    expect(supportsImages()).toBe(true);
  });
});
