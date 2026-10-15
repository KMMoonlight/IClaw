import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, resetConfigCache, resolveStateDir } from "./config.js";

const KEYS = [
  "ICLAW_MODEL_PROVIDER",
  "ICLAW_MODEL",
  "ICLAW_MODEL_BASE_URL",
  "ICLAW_MODEL_CONTEXT_WINDOW",
  "ICLAW_MODEL_MAX_TOKENS",
  "ICLAW_MODEL_SUPPORTS_IMAGES",
  "ICLAW_MEMORY_AUTO_EXTRACT",
  "ICLAW_SCHEDULER_ENABLED",
  "ICLAW_SCHEDULER_INTERVAL_MS",
  "ICLAW_TOOLS_EXEC",
  "ICLAW_WORKSPACE_DIR",
  "ICLAW_EXEC_TIMEOUT_MS",
  "ICLAW_EXEC_SANDBOX",
  "ICLAW_EXEC_ALLOW_NETWORK",
  "ICLAW_APPROVAL_TOOLS",
  "ICLAW_SEND_CHUNK_CHARS",
  "ICLAW_STREAM_PROGRESS",
  "ICLAW_SEND_MEDIA_MAX_BYTES",
  "ICLAW_USER_DAILY_TOKEN_LIMIT",
  "ICLAW_USER_RATE_PER_MIN",
  "ICLAW_MODEL_FALLBACK",
  "ICLAW_SEND_RETRIES",
  "ICLAW_OUTBOUND_BLOCKLIST",
  "ICLAW_OUTBOUND_BLOCK_MESSAGE",
  "ICLAW_DATA_RETENTION_DAYS",
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
    setEnv("ICLAW_MEMORY_AUTO_EXTRACT", "");
    setEnv("ICLAW_COOKIE_SECURE", "");
    const cfg = loadConfig();
    expect(cfg.model.provider).toBe("openai");
    expect(cfg.modelContextWindow).toBe(128000);
    expect(cfg.modelMaxTokens).toBe(8192);
    expect(cfg.modelSupportsImages).toBe(true);
    expect(cfg.memoryAutoExtract).toBe(false);
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

  it("parses the memory auto-extract flag", () => {
    setEnv("ICLAW_MEMORY_AUTO_EXTRACT", "true");
    resetConfigCache();
    expect(loadConfig().memoryAutoExtract).toBe(true);
    setEnv("ICLAW_MEMORY_AUTO_EXTRACT", "off");
    resetConfigCache();
    expect(loadConfig().memoryAutoExtract).toBe(false);
  });

  it("parses scheduler enablement and interval", () => {
    setEnv("ICLAW_SCHEDULER_ENABLED", "false");
    setEnv("ICLAW_SCHEDULER_INTERVAL_MS", "5000");
    resetConfigCache();
    expect(loadConfig().schedulerEnabled).toBe(false);
    expect(loadConfig().schedulerIntervalMs).toBe(5000);
  });

  it("parses exec tool settings", () => {
    setEnv("ICLAW_TOOLS_EXEC", "true");
    setEnv("ICLAW_EXEC_TIMEOUT_MS", "15000");
    setEnv("ICLAW_WORKSPACE_DIR", "./ws");
    resetConfigCache();
    expect(loadConfig().toolsExec).toBe(true);
    expect(loadConfig().execTimeoutMs).toBe(15000);
    expect(loadConfig().workspaceDir).toBe("./ws");
    expect(loadConfig().execSandbox).toBe("auto");
    expect(loadConfig().execAllowNetwork).toBe(false);
  });

  it("validates the sandbox mode enum", () => {
    setEnv("ICLAW_EXEC_SANDBOX", "required");
    setEnv("ICLAW_EXEC_ALLOW_NETWORK", "yes");
    resetConfigCache();
    expect(loadConfig().execSandbox).toBe("required");
    expect(loadConfig().execAllowNetwork).toBe(true);
    setEnv("ICLAW_EXEC_SANDBOX", "bogus");
    resetConfigCache();
    expect(loadConfig().execSandbox).toBe("auto");
  });

  it("defaults to no approval — every tool executes directly", () => {
    setEnv("ICLAW_APPROVAL_TOOLS", undefined);
    resetConfigCache();
    expect(loadConfig().approvalTools).toEqual([]);
  });

  it("parses the approval tool list (empty disables approval)", () => {
    setEnv("ICLAW_APPROVAL_TOOLS", "bash, write_file");
    resetConfigCache();
    expect(loadConfig().approvalTools).toEqual(["bash", "write_file"]);
    setEnv("ICLAW_APPROVAL_TOOLS", "");
    resetConfigCache();
    expect(loadConfig().approvalTools).toEqual([]);
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
