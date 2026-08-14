import path from "node:path";

// --- 协议固定常量（无需配置）---
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const DEFAULT_BOT_TYPE = "3";
export const DEFAULT_BOT_AGENT = "IClaw/1.0";

export interface ModelConfig {
  provider: string;
  model: string;
}

export interface ServerConfig {
  host: string;
  port: number;
}

/** 应用运行时配置（仅真正的变量，来自环境 / .env）。 */
export interface IClawConfig {
  stateDir: string;
  model: ModelConfig;
  /** OpenAI/Anthropic 兼容端点（可选；缺省用 provider 的内置 base URL）。 */
  modelBaseUrl?: string;
  /** API key（必填）。 */
  apiKey?: string;
  systemPrompt: string;
  skillsDir: string;
  mcpConfigPath: string;
  server: ServerConfig;
  adminUser: string;
}

const DEFAULTS: IClawConfig = {
  stateDir: "./data",
  model: { provider: "openai", model: "" },
  systemPrompt: "你是一个乐于助人的助手。用用户使用的语言简洁地回答。",
  skillsDir: "./skills",
  mcpConfigPath: "./mcp.json",
  server: { host: "127.0.0.1", port: 3000 },
  adminUser: "admin",
};

let cached: IClawConfig | null = null;

/** Load `.env` into process.env if present (Node built-in, no extra dependency). */
function loadEnvFileIfPresent(): void {
  try {
    process.loadEnvFile(path.resolve(".env"));
  } catch {
    // .env missing — rely on ambient environment variables.
  }
}

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function envInt(key: string, fallback: number): number {
  const v = Number(env(key, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

function envOptional(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export function loadConfig(): IClawConfig {
  if (cached) return cached;
  loadEnvFileIfPresent();
  cached = {
    stateDir: env("ICLAW_STATE_DIR", DEFAULTS.stateDir),
    model: {
      provider: env("ICLAW_MODEL_PROVIDER", DEFAULTS.model.provider),
      model: env("ICLAW_MODEL", DEFAULTS.model.model),
    },
    modelBaseUrl: envOptional("ICLAW_MODEL_BASE_URL"),
    apiKey: envOptional("ICLAW_API_KEY"),
    systemPrompt: env("ICLAW_SYSTEM_PROMPT", DEFAULTS.systemPrompt),
    skillsDir: env("ICLAW_SKILLS_DIR", DEFAULTS.skillsDir),
    mcpConfigPath: env("ICLAW_MCP_CONFIG", DEFAULTS.mcpConfigPath),
    server: {
      host: env("ICLAW_SERVER_HOST", DEFAULTS.server.host),
      port: envInt("ICLAW_SERVER_PORT", DEFAULTS.server.port),
    },
    adminUser: env("ICLAW_ADMIN_USER", DEFAULTS.adminUser),
  };
  return cached;
}

export function resolveStateDir(): string {
  const dir = loadConfig().stateDir;
  return path.isAbsolute(dir) ? dir : path.resolve(dir);
}

/** For test / reset purposes. */
export function resetConfigCache(): void {
  cached = null;
}
