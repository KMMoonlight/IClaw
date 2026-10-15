import { loadConfig } from "../config.js";
import { resolveBaseUrl } from "./models.js";

/** Embedding requests are a single short API call; cap the wait. */
const EMBEDDING_TIMEOUT_MS = 15_000;

export interface EmbeddingOptions {
  /** Injectable fetch (tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Whether an embedding model is configured (ICLAW_EMBEDDING_MODEL). */
export function embeddingsEnabled(): boolean {
  return Boolean(loadConfig().embeddingModel);
}

/**
 * Resolve the OpenAI-compatible `/embeddings` endpoint.
 * Precedence: ICLAW_EMBEDDING_BASE_URL → ICLAW_MODEL_BASE_URL → provider built-in.
 * Returns null when embeddings are not configured or the base URL is unusable.
 */
export function resolveEmbeddingEndpoint(): string | null {
  const cfg = loadConfig();
  if (!cfg.embeddingModel) return null;
  let base: string;
  try {
    base = resolveBaseUrl(cfg.model.provider, cfg.embeddingBaseUrl ?? cfg.modelBaseUrl);
  } catch {
    // Unknown provider without an explicit base URL — no way to reach /embeddings.
    return null;
  }
  return `${base.replace(/\/+$/, "")}/embeddings`;
}

/** API key used for embeddings: reuse ICLAW_API_KEY (falls back to common env vars). */
function embeddingApiKey(): string | undefined {
  const cfg = loadConfig();
  return cfg.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.ICLAW_API_KEY ?? undefined;
}

/** Cosine similarity of two (possibly mismatched-length) vectors, clamped to [0, 1]. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Negative similarity means unrelated; treat as 0 for ranking purposes.
  return Math.max(0, Math.min(1, sim));
}

/**
 * Embed a batch of texts via the OpenAI-compatible `/embeddings` endpoint.
 * Throws when embeddings are not configured or the call fails — callers are
 * expected to degrade to keyword retrieval.
 */
export async function embedTexts(texts: string[], opts: EmbeddingOptions = {}): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const endpoint = resolveEmbeddingEndpoint();
  const apiKey = embeddingApiKey();
  const model = loadConfig().embeddingModel;
  if (!endpoint || !apiKey || !model) {
    throw new Error("embeddings not configured");
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? EMBEDDING_TIMEOUT_MS);
  opts.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(`embeddings: expected ${texts.length} vector(s), got ${data.length}`);
    }
    return data.map((d) => Float32Array.from(d.embedding ?? []));
  } finally {
    clearTimeout(timer);
  }
}

/** Embed a single text. */
export async function embedText(text: string, opts: EmbeddingOptions = {}): Promise<Float32Array> {
  const [vec] = await embedTexts([text], opts);
  if (!vec || vec.length === 0) throw new Error("embeddings: empty response");
  return vec;
}
