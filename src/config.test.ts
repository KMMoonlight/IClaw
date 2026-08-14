import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, resetConfigCache, resolveStateDir } from "./config.js";

const KEYS = [
  "ICLAW_MODEL_PROVIDER",
  "ICLAW_MODEL",
  "ICLAW_MODEL_BASE_URL",
  "ICLAW_MODEL_CONTEXT_WINDOW",
  "ICLAW_MODEL_MAX_TOKENS",
  "ICLAW_MODEL_SUPPORTS_IMAGES",
  "ICLAW_SERVER_PORT",
  "ICLAW_COOKIE_SECURE",
  "ICLAW_STATE_DIR",
] as const;

const saved = new Map<string, string | undefined>();
for (const k of KEYS) saved.set(k, process.env[k]);

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const k of KEYS) setEnv(k, saved.get(k));
  resetConfigCache();
});

describe("loadConfig", () => {
  it("reads model config from env", () => {
    setEnv("ICLAW_MODEL_PROVIDER", "deepseek");
    setEnv("ICLAW_MODEL", "deepseek-chat");
    const cfg = loadConfig();
    expect(cfg.model.provider).toBe("deepseek");
    expect(cfg.model.model).toBe("deepseek-chat");
  });

  it("applies defaults when env is unset", () => {
    // Empty string counts as "unset" for config parsing, and Node's
    // loadEnvFile never overrides variables that already exist — so this
    // stays hermetic even when a real .env file is present in the repo root.
    setEnv("ICLAW_MODEL_PROVIDER", "");
    setEnv("ICLAW_MODEL", "");
    setEnv("ICLAW_MODEL_CONTEXT_WINDOW", "");
    setEnv("ICLAW_MODEL_MAX_TOKENS", "");
    setEnv("ICLAW_MODEL_SUPPORTS_IMAGES", "");
    setEnv("ICLAW_COOKIE_SECURE", "");
    const cfg = loadConfig();
    expect(cfg.model.provider).toBe("openai");
    expect(cfg.modelContextWindow).toBe(128000);
    expect(cfg.modelMaxTokens).toBe(8192);
    expect(cfg.modelSupportsImages).toBe(true);
    expect(cfg.cookieSecure).toBe(false);
  });

  it("parses ints and falls back on garbage", () => {
    setEnv("ICLAW_SERVER_PORT", "4242");
    resetConfigCache();
    expect(loadConfig().server.port).toBe(4242);
    setEnv("ICLAW_SERVER_PORT", "not-a-number");
    resetConfigCache();
    expect(loadConfig().server.port).toBe(3000);
  });

  it("parses booleans from multiple spellings", () => {
    setEnv("ICLAW_MODEL_SUPPORTS_IMAGES", "false");
    resetConfigCache();
    expect(loadConfig().modelSupportsImages).toBe(false);
    setEnv("ICLAW_MODEL_SUPPORTS_IMAGES", "0");
    resetConfigCache();
    expect(loadConfig().modelSupportsImages).toBe(false);
    setEnv("ICLAW_MODEL_SUPPORTS_IMAGES", "1");
    resetConfigCache();
    expect(loadConfig().modelSupportsImages).toBe(true);
    setEnv("ICLAW_MODEL_SUPPORTS_IMAGES", "yes");
    resetConfigCache();
    expect(loadConfig().modelSupportsImages).toBe(true);
  });

  it("caches the config until reset", () => {
    setEnv("ICLAW_MODEL_PROVIDER", "qwen");
    expect(loadConfig().model.provider).toBe("qwen");
    setEnv("ICLAW_MODEL_PROVIDER", "zhipu");
    expect(loadConfig().model.provider).toBe("qwen");
    resetConfigCache();
    expect(loadConfig().model.provider).toBe("zhipu");
  });

  it("resolves the state dir to an absolute path", () => {
    setEnv("ICLAW_STATE_DIR", "./relative-data");
    const resolved = resolveStateDir();
    expect(resolved).toBe(require("node:path").resolve("relative-data"));
  });
});
