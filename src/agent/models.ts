import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { ApiKeyAuth, MutableModels, Model, Provider, ProviderStreams } from "@earendil-works/pi-ai";

import { loadConfig } from "../config.js";

const PROVIDER_ID = "custom";

type ApiKind = "openai-completions" | "openai-responses" | "anthropic-messages";

interface ProviderSpec {
  baseUrl: string;
  api: ApiKind;
  /** 用 `Authorization: Bearer` 而非 `x-api-key`（订阅制，如 Kimi 编程会员）。 */
  bearerAuth?: boolean;
}

/**
 * 支持的 provider：`ICLAW_MODEL_PROVIDER` 的值 → 默认 baseUrl + 协议 + 鉴权方式。
 * 未列出的 provider 视为 OpenAI chat completions 兼容，且必须显式设置 `ICLAW_MODEL_BASE_URL`。
 */
export const PROVIDERS: Record<string, ProviderSpec> = {
  // OpenAI 兼容（openai-completions）
  openai: { baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
  "openai-responses": { baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
  deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions" },
  qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions" },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", api: "openai-completions" },
  zhipu: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions" },
  siliconflow: { baseUrl: "https://api.siliconflow.cn/v1", api: "openai-completions" },
  volcengine: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", api: "openai-completions" },
  stepfun: { baseUrl: "https://api.stepfun.com/v1", api: "openai-completions" },
  baichuan: { baseUrl: "https://api.baichuan-ai.com/v1", api: "openai-completions" },
  zai: { baseUrl: "https://api.z.ai/api/paas/v4", api: "openai-completions" },
  minimax: { baseUrl: "https://api.minimax.chat/v1", api: "openai-completions" },
  spark: { baseUrl: "https://spark-api-open.xf-yun.com/v1", api: "openai-completions" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", api: "openai-completions" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions" },
  together: { baseUrl: "https://api.together.xyz/v1", api: "openai-completions" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", api: "openai-completions" },
  xai: { baseUrl: "https://api.x.ai/v1", api: "openai-completions" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", api: "openai-completions" },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", api: "openai-completions" },
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", api: "openai-completions" },
  ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions" },
  // Anthropic 兼容（anthropic-messages）
  anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
  "kimi-code": { baseUrl: "https://api.kimi.com/coding", api: "anthropic-messages", bearerAuth: true },
};

function apiImplFor(kind: ApiKind): ProviderStreams {
  switch (kind) {
    case "openai-responses":
      return openAIResponsesApi();
    case "anthropic-messages":
      return anthropicMessagesApi();
    default:
      return openAICompletionsApi();
  }
}

function apiKindFor(provider: string): ApiKind {
  return PROVIDERS[provider]?.api ?? "openai-completions";
}

export function resolveBaseUrl(provider: string, override?: string): string {
  if (override) return override;
  const spec = PROVIDERS[provider];
  if (spec) return spec.baseUrl;
  throw new Error(
    `Unknown provider "${provider}" — set ICLAW_MODEL_BASE_URL to your endpoint (protocol defaults to openai-completions)`,
  );
}

/** 订阅制 provider 的鉴权：把 key 作为 `Authorization: Bearer` 头发出，而非 `x-api-key`。 */
function bearerEnvApiKeyAuth(name: string, envVars: string[]): ApiKeyAuth {
  return {
    name,
    resolve: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      if (credential?.key) {
        return { auth: { headers: { authorization: `Bearer ${credential.key}` } }, source: "stored credential" };
      }
      for (const envVar of envVars) {
        const value = await ctx.env(envVar);
        signal.throwIfAborted();
        if (value) {
          return { auth: { headers: { authorization: `Bearer ${value}` } }, source: envVar };
        }
      }
      return undefined;
    },
  };
}

const KEY_ENV_VARS = ["ICLAW_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"];

let models: MutableModels | null = null;

/** Build the single provider, using `ICLAW_MODEL_BASE_URL` when set, else the provider's built-in base URL. */
function buildCustomProvider(): Provider {
  const cfg = loadConfig();
  if (!cfg.model.model) {
    throw new Error("ICLAW_MODEL is required — set the model name in .env");
  }
  const spec = PROVIDERS[cfg.model.provider];
  const apiKind = apiKindFor(cfg.model.provider);
  const baseUrl = resolveBaseUrl(cfg.model.provider, cfg.modelBaseUrl);
  const model: Model<any> = {
    id: cfg.model.model,
    name: cfg.model.model,
    api: apiKind,
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: cfg.modelSupportsImages ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.modelContextWindow,
    maxTokens: cfg.modelMaxTokens,
  };
  return createProvider({
    id: PROVIDER_ID,
    name: "Custom",
    baseUrl,
    auth: {
      apiKey: spec?.bearerAuth
        ? bearerEnvApiKeyAuth("API key", KEY_ENV_VARS)
        : envApiKeyAuth("API key", KEY_ENV_VARS),
    },
    models: [model],
    api: apiImplFor(apiKind),
  }) as unknown as Provider;
}

export function getModels(): MutableModels {
  if (models) return models;
  models = createModels();
  models.setProvider(buildCustomProvider());
  return models;
}

/** Resolve the single global model. */
export function resolveConfiguredModel(): Model<any> {
  const cfg = loadConfig();
  const m = getModels().getModel(PROVIDER_ID, cfg.model.model);
  if (!m) {
    throw new Error(`Model not found: ${cfg.model.model} — check ICLAW_MODEL in .env`);
  }
  return m;
}

/** Whether the configured model accepts image input (ICLAW_MODEL_SUPPORTS_IMAGES). */
export function supportsImages(): boolean {
  return loadConfig().modelSupportsImages;
}
