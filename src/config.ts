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
  /** 模型上下文窗口大小（token 数，供 pi 做上下文管理）。 */
  modelContextWindow: number;
  /** 单次回复最大 token 数。 */
  modelMaxTokens: number;
  /** 模型是否支持图片输入；false 时收到的图片会转为文字提示。 */
  modelSupportsImages: boolean;
  /** 是否在每轮对话后自动抽取值得长期记住的事实（默认关闭）。 */
  memoryAutoExtract: boolean;
  /** 可选：embedding 模型名（OpenAI 兼容 `/embeddings`）。未设时记忆检索降级为关键词。 */
  embeddingModel?: string;
  /** 可选：embedding 端点覆盖；缺省复用 modelBaseUrl / provider 内置地址。 */
  embeddingBaseUrl?: string;
  /** 是否启用后台定时任务调度器。 */
  schedulerEnabled: boolean;
  /** 调度器轮询间隔（毫秒）。 */
  schedulerIntervalMs: number;
  /** 是否启用 bash / 文件读写等执行类工具（默认关闭）。 */
  toolsExec: boolean;
  /** 执行类工具的工作目录根（每个用户在子目录下隔离）；缺省 <stateDir>/workspaces。 */
  workspaceDir?: string;
  /** 单次命令执行超时（毫秒）。 */
  execTimeoutMs: number;
  /** 单次命令输出字节上限。 */
  execMaxOutputBytes: number;
  /** 沙箱模式：auto（有工具则用）/ required（无沙箱则拒绝执行）/ none（不沙箱，不建议）。 */
  execSandbox: "auto" | "required" | "none";
  /** 沙箱内是否允许出站网络（默认禁止）。 */
  execAllowNetwork: boolean;
  /** 联网搜索后端：none / tavily / brave / searxng。 */
  searchProvider: "none" | "tavily" | "brave" | "searxng";
  /** 搜索后端 API key（tavily / brave 需要）。 */
  searchApiKey?: string;
  /** 搜索后端地址覆盖（searxng 必填；其他可选）。 */
  searchBaseUrl?: string;
  /**
   * 需要用户确认才能执行的工具名。默认空数组 = 全部直接执行（默认放行，不做人工审批）。
   * 如需对个别危险工具开启人工确认，设置 `ICLAW_APPROVAL_TOOLS=bash,write_file`。
   */
  approvalTools: string[];
  /** 单条出站文本最大字符数，超过则分片发送。 */
  sendChunkChars: number;
  /** 是否在生成过程中分段推送长回复（流式体验）。 */
  streamProgress: boolean;
  /** 出站媒体文件大小上限（字节）。 */
  sendMediaMaxBytes: number;
  /** 每用户每日 token 上限（0 = 不限）。 */
  userDailyTokenLimit: number;
  /** 每用户每分钟消息数上限（0 = 不限）。 */
  userRatePerMin: number;
  /** 主模型失败时自动重试的备用模型（可选）。 */
  modelFallback?: string;
  /** 出站发送失败时的重试次数（0 = 不重试）。 */
  sendRetries: number;
  /** 出站内容黑名单（正则，命中则替换为 blockMessage）。 */
  outboundBlocklist: string[];
  /** 命中黑名单时发送的替代文本。 */
  outboundBlockMessage: string;
  /** 数据保留天数（0 = 永久保留）；超过则清理会话/审计/用量。 */
  dataRetentionDays: number;
  systemPrompt: string;
  skillsDir: string;
  mcpConfigPath: string;
  server: ServerConfig;
  adminUser: string;
  /** 会话 cookie 是否带 Secure 标志（对外暴露时建议配 HTTPS 并开启）。 */
  cookieSecure: boolean;
}

const DEFAULTS: IClawConfig = {
  stateDir: "./data",
  model: { provider: "openai", model: "" },
  modelContextWindow: 128_000,
  modelMaxTokens: 8192,
  modelSupportsImages: true,
  memoryAutoExtract: false,
  schedulerEnabled: true,
  schedulerIntervalMs: 30_000,
  toolsExec: false,
  execTimeoutMs: 30_000,
  execMaxOutputBytes: 100_000,
  execSandbox: "auto",
  execAllowNetwork: false,
  searchProvider: "none",
  approvalTools: [], // default: no approval — tools execute directly (opt-in via ICLAW_APPROVAL_TOOLS)
  sendChunkChars: 2000,
  streamProgress: true,
  sendMediaMaxBytes: 20 * 1024 * 1024,
  userDailyTokenLimit: 0,
  userRatePerMin: 0,
  modelFallback: undefined,
  sendRetries: 2,
  outboundBlocklist: [],
  outboundBlockMessage: "抱歉，这条内容不适合发送。",
  dataRetentionDays: 0,
  systemPrompt: "你是一个乐于助人的助手。用用户使用的语言简洁地回答。",
  skillsDir: "./skills",
  mcpConfigPath: "./mcp.json",
  server: { host: "127.0.0.1", port: 3000 },
  adminUser: "admin",
  cookieSecure: false,
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

function envBool(key: string, fallback: boolean): boolean {
  const v = envOptional(key);
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function envOneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = envOptional(key);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Parse a comma-separated list env var; an explicitly empty value yields []. */
function envList(key: string, fallback: string[]): string[] {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
    modelContextWindow: envInt("ICLAW_MODEL_CONTEXT_WINDOW", DEFAULTS.modelContextWindow),
    modelMaxTokens: envInt("ICLAW_MODEL_MAX_TOKENS", DEFAULTS.modelMaxTokens),
    modelSupportsImages: envBool("ICLAW_MODEL_SUPPORTS_IMAGES", DEFAULTS.modelSupportsImages),
    memoryAutoExtract: envBool("ICLAW_MEMORY_AUTO_EXTRACT", DEFAULTS.memoryAutoExtract),
    embeddingModel: envOptional("ICLAW_EMBEDDING_MODEL"),
    embeddingBaseUrl: envOptional("ICLAW_EMBEDDING_BASE_URL"),
    schedulerEnabled: envBool("ICLAW_SCHEDULER_ENABLED", DEFAULTS.schedulerEnabled),
    schedulerIntervalMs: envInt("ICLAW_SCHEDULER_INTERVAL_MS", DEFAULTS.schedulerIntervalMs),
    toolsExec: envBool("ICLAW_TOOLS_EXEC", DEFAULTS.toolsExec),
    workspaceDir: envOptional("ICLAW_WORKSPACE_DIR"),
    execTimeoutMs: envInt("ICLAW_EXEC_TIMEOUT_MS", DEFAULTS.execTimeoutMs),
    execMaxOutputBytes: envInt("ICLAW_EXEC_MAX_OUTPUT_BYTES", DEFAULTS.execMaxOutputBytes),
    execSandbox: envOneOf("ICLAW_EXEC_SANDBOX", ["auto", "required", "none"] as const, DEFAULTS.execSandbox),
    execAllowNetwork: envBool("ICLAW_EXEC_ALLOW_NETWORK", DEFAULTS.execAllowNetwork),
    searchProvider: envOneOf("ICLAW_SEARCH_PROVIDER", ["none", "tavily", "brave", "searxng"] as const, DEFAULTS.searchProvider),
    searchApiKey: envOptional("ICLAW_SEARCH_API_KEY"),
    searchBaseUrl: envOptional("ICLAW_SEARCH_BASE_URL"),
    approvalTools: envList("ICLAW_APPROVAL_TOOLS", DEFAULTS.approvalTools),
    sendChunkChars: envInt("ICLAW_SEND_CHUNK_CHARS", DEFAULTS.sendChunkChars),
    streamProgress: envBool("ICLAW_STREAM_PROGRESS", DEFAULTS.streamProgress),
    sendMediaMaxBytes: envInt("ICLAW_SEND_MEDIA_MAX_BYTES", DEFAULTS.sendMediaMaxBytes),
    userDailyTokenLimit: envInt("ICLAW_USER_DAILY_TOKEN_LIMIT", DEFAULTS.userDailyTokenLimit),
    userRatePerMin: envInt("ICLAW_USER_RATE_PER_MIN", DEFAULTS.userRatePerMin),
    modelFallback: envOptional("ICLAW_MODEL_FALLBACK"),
    sendRetries: envInt("ICLAW_SEND_RETRIES", DEFAULTS.sendRetries),
    outboundBlocklist: envList("ICLAW_OUTBOUND_BLOCKLIST", DEFAULTS.outboundBlocklist),
    outboundBlockMessage: env("ICLAW_OUTBOUND_BLOCK_MESSAGE", DEFAULTS.outboundBlockMessage),
    dataRetentionDays: envInt("ICLAW_DATA_RETENTION_DAYS", DEFAULTS.dataRetentionDays),
    systemPrompt: env("ICLAW_SYSTEM_PROMPT", DEFAULTS.systemPrompt),
    skillsDir: env("ICLAW_SKILLS_DIR", DEFAULTS.skillsDir),
    mcpConfigPath: env("ICLAW_MCP_CONFIG", DEFAULTS.mcpConfigPath),
    server: {
      host: env("ICLAW_SERVER_HOST", DEFAULTS.server.host),
      port: envInt("ICLAW_SERVER_PORT", DEFAULTS.server.port),
    },
    adminUser: env("ICLAW_ADMIN_USER", DEFAULTS.adminUser),
    cookieSecure: envBool("ICLAW_COOKIE_SECURE", DEFAULTS.cookieSecure),
  };
  return cached;
}

export function resolveStateDir(): string {
  const dir = loadConfig().stateDir;
  return path.isAbsolute(dir) ? dir : path.resolve(dir);
}

/** Root directory for per-user exec workspaces (defaults under the state dir). */
export function resolveWorkspaceDir(): string {
  const dir = loadConfig().workspaceDir ?? path.join(resolveStateDir(), "workspaces");
  return path.isAbsolute(dir) ? dir : path.resolve(dir);
}

/** For test / reset purposes. */
export function resetConfigCache(): void {
  cached = null;
}
