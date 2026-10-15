import fs from "node:fs";

import { Agent } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";

import { loadConfig } from "../config.js";
import { summarizeAuditArgs } from "../audit.js";
import { inc, observe } from "../metrics.js";
import { clearUserSession, disabledSkillNamesForUser, getUser, loadMessagesJson, recordAudit, recordUsage, saveMessagesJson } from "../db/index.js";
import { logger } from "../logger.js";
import type { User } from "../db/index.js";
import type { InboundContext } from "../wechat/inbound.js";
import { clearPendingAction } from "./approvals.js";
import { buildMcpTools, resetMcpClients } from "./mcp.js";
import { extractAndRememberMemories } from "./memory-extract.js";
import { buildMemorySection } from "./memory.js";
import { retrieveMemories } from "./memory-retrieval.js";
import { getModels, resolveFallbackModel, resolveModelFor, supportsImages } from "./models.js";
import { resetSkillsCache, skillsPrompt } from "./skills.js";
import { buildTools } from "./tools.js";
import { SECURITY_POLICY } from "./security.js";
import { hasUsage, lastAssistantUsage } from "./usage.js";
import { checkQuota } from "./quota.js";
import { beginWork, endWork } from "./inflight.js";
import { maybeCompactTranscript, trimMessages, TRANSCRIPT_MAX_MESSAGES } from "./transcript.js";

/** One Agent instance per user, sharing model/tools/system-prompt shape but with isolated transcripts. */
const agents = new Map<string, Agent>();
/** Last time each agent processed a turn, for idle eviction. */
const lastUsed = new Map<string, number>();
/** Per-user turn chains: Agent.prompt rejects concurrent calls, so turns for one user run one at a time. */
const turnChains = new Map<string, Promise<unknown>>();
/** Per-user streaming hooks for the currently-running turn. */
const turnHooks = new Map<string, RunHooks>();

/** Optional hooks a caller can attach to a running turn (used for streaming). */
export interface RunHooks {
  onTextDelta?: (delta: string) => void;
  /** Called before retrying with the fallback model, so callers can drop stale output. */
  onRetry?: () => void;
}

/** Evict an agent that has been idle this long (transcript stays persisted in the DB). */
const AGENT_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

/** Shared (non-user-bound) tools: MCP tools built once at startup. */
let sharedTools: AgentTool<any>[] = [];

/** Build the shared tool set (skills are lazy; MCP tools connect here). Call once at startup. */
export async function initSharedTools(): Promise<void> {
  resetSkillsCache();
  sharedTools = await buildMcpTools();
}

/**
 * Rebuild MCP tools after the admin edits the MCP config — no restart needed.
 * Refreshes the tool set of every cached agent so the change applies to
 * subsequent turns immediately.
 */
export async function reloadSharedTools(): Promise<void> {
  resetMcpClients();
  resetSkillsCache();
  sharedTools = await buildMcpTools();
  for (const [userId, agent] of agents) {
    try {
      agent.state.tools = buildTools(userId, sharedTools);
    } catch (err) {
      logger.warn(`runtime: failed to refresh tools for ${userId}: ${String(err)}`);
    }
  }
}

async function buildSystemPrompt(user: User, tools: AgentTool<any>[], query = ""): Promise<string> {
  const parts: string[] = [loadConfig().systemPrompt];
  if (user.persona.trim()) parts.push(`## 当前用户\n${user.persona}`);
  // Relevance-scored memory retrieval (vector when configured, keyword fallback).
  const { memories } = await retrieveMemories(user.id, query);
  const memorySection = buildMemorySection(memories);
  if (memorySection) parts.push(memorySection);
  const sp = skillsPrompt(disabledSkillNamesForUser(user.id));
  if (sp) parts.push(sp);
  const toolNames = [...new Set(tools.map((t) => t.name))];
  parts.push(`## 当前可用工具\n${toolNames.join(", ")}`);
  parts.push(SECURITY_POLICY);
  return parts.join("\n\n");
}

function fileToImageContent(filePath: string, mediaType?: string): ImageContent[] {
  const data = fs.readFileSync(filePath).toString("base64");
  // media.type is usually "image/*"; only pass through concrete mime types.
  const mimeType = mediaType && /^image\/[a-z0-9.+-]+$/i.test(mediaType) ? mediaType : "image/jpeg";
  return [{ type: "image", data, mimeType }];
}

function lastAssistantText(agent: Agent): string {
  const msgs = agent.state.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "assistant") {
      const text = contentText(m.content);
      if (text.trim()) return text;
    }
  }
  return "";
}

export { trimMessages } from "./transcript.js";

function sweepIdleAgents(now: number): void {
  for (const [userId, agent] of agents) {
    const used = lastUsed.get(userId) ?? 0;
    if (now - used > AGENT_IDLE_TTL_MS) {
      agents.delete(userId);
      lastUsed.delete(userId);
      void agent;
    }
  }
}

export async function getOrCreateAgent(userId: string): Promise<Agent> {
  sweepIdleAgents(Date.now());
  const existing = agents.get(userId);
  if (existing) return existing;

  const user = getUser(userId);
  if (!user) throw new Error(`user not found: ${userId}`);

  const parsed = JSON.parse(loadMessagesJson(userId)) as AgentMessage[];
  const messages = trimMessages(Array.isArray(parsed) ? parsed : [], TRANSCRIPT_MAX_MESSAGES);
  const models = getModels();
  const tools = buildTools(userId, sharedTools);
  const agent = new Agent({
    initialState: {
      systemPrompt: await buildSystemPrompt(user, tools),
      model: resolveModelFor(user),
      tools,
      messages,
    },
    streamFn: models.streamSimple.bind(models),
    sessionId: userId,
  });
  agents.set(userId, agent);
  // Forward streaming deltas to the active turn and record tool calls for audit.
  const toolArgs = new Map<string, string>();
  agent.subscribe((event) => {
    if (event.type === "message_update") {
      const ev = event.assistantMessageEvent;
      if (ev.type === "text_delta") turnHooks.get(userId)?.onTextDelta?.(ev.delta);
      return;
    }
    if (event.type === "tool_execution_start") {
      toolArgs.set(event.toolCallId, summarizeAuditArgs(event.args));
      return;
    }
    if (event.type === "tool_execution_end") {
      const detail = `${event.isError ? "error" : "ok"} ${toolArgs.get(event.toolCallId) ?? ""}`.trim();
      toolArgs.delete(event.toolCallId);
      recordAudit({ userId, actor: "agent", action: `tool:${event.toolName}`, detail });
      inc("iclaw_tool_calls_total", { tool: event.toolName, status: event.isError ? "error" : "ok" });
    }
  });
  return agent;
}

export function dropAgent(userId: string): void {
  agents.delete(userId);
  lastUsed.delete(userId);
  // A rebuilt agent must not inherit a stale pending dangerous-tool approval.
  clearPendingAction(userId);
}

export function dropAllAgents(): void {
  agents.clear();
  lastUsed.clear();
}

/** Wipe a user's transcript and unload their agent (new session). */
export function resetUserSession(userId: string): void {
  clearUserSession(userId);
  dropAgent(userId);
}

/**
 * Run one agent turn for a bound, active user. Returns the assistant's reply text.
 * Turns for the same user are serialized: Agent.prompt rejects concurrent calls,
 * and multiple WeChat accounts may deliver messages for one user in parallel.
 */
function enqueueTurn<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const prev = turnChains.get(userId) ?? Promise.resolve();
  const next = prev.then(task);
  // Keep the chain alive even after failures; the caller receives the real error.
  turnChains.set(userId, next.catch(() => undefined));
  return next;
}

export function runAgentTurn(userId: string, ctx: InboundContext, hooks?: RunHooks): Promise<string> {
  return enqueueTurn(userId, async () => {
    if (hooks) turnHooks.set(userId, hooks);
    else turnHooks.delete(userId);
    beginWork();
    try {
      return await runAgentTurnInner(userId, ctx);
    } finally {
      turnHooks.delete(userId);
      endWork();
    }
  });
}

/**
 * Run `task` on the user's turn chain, so it never races an in-flight agent turn
 * (used for executing an approved dangerous tool). Counts toward graceful drain.
 */
export function runUserExclusive<T>(userId: string, task: () => Promise<T>): Promise<T> {
  return enqueueTurn(userId, () => {
    beginWork();
    return Promise.resolve()
      .then(task)
      .finally(() => endWork());
  });
}

/**
 * Run an agent turn triggered by the scheduler (no inbound message). Returns the
 * assistant reply, or "" when the user is missing/frozen. Serialized with the
 * user's regular turns via the same chain.
 */
export function runScheduledAgentTurn(userId: string, instruction: string): Promise<string> {
  const user = getUser(userId);
  if (!user || user.status !== "active") return Promise.resolve("");
  const quota = checkQuota(userId);
  if (!quota.allowed) {
    logger.warn(`runtime: scheduled turn skipped for ${userId}: ${quota.reason}`);
    return Promise.resolve("");
  }
  return runAgentTurn(userId, { body: instruction, from: "", accountId: "" });
}

async function runAgentTurnInner(userId: string, ctx: InboundContext): Promise<string> {
  const agent = await getOrCreateAgent(userId);
  lastUsed.set(userId, Date.now());
  const user = getUser(userId)!;

  let body = ctx.body.trim() || "(empty)";
  // Refresh persona/memory each turn, ranking memory relevance against the
  // incoming message so newly-remembered/related facts surface immediately.
  agent.state.systemPrompt = await buildSystemPrompt(user, agent.state.tools, body);

  let images: ImageContent[] | undefined;
  if (ctx.media) {
    if (ctx.media.type.startsWith("image/") && supportsImages()) {
      images = fileToImageContent(ctx.media.path, ctx.media.type);
    } else if (ctx.media.type.startsWith("image/")) {
      body = `[图片消息：当前模型不支持图片输入]\n${body}`;
    }
    // Non-image attachments are already described in `body` by the inbound layer.
  }

  // Apply the user's model (may change at runtime) and run the turn, retrying
  // once with the configured fallback model on failure.
  agent.state.model = resolveModelFor(user);
  const messagesBefore = agent.state.messages.length;
  const startedAt = Date.now();
  try {
    await agent.prompt(body, images);
  } catch (err) {
    const fallback = resolveFallbackModel();
    const currentId = (agent.state.model as { id?: string }).id;
    if (!fallback || fallback.id === currentId) {
      inc("iclaw_turns_total", { status: "error" });
      observe("iclaw_turn_duration_seconds", (Date.now() - startedAt) / 1000);
      throw err;
    }
    inc("iclaw_model_fallback_total");
    logger.warn(`runtime: model ${currentId} failed for ${userId}, retrying with fallback ${fallback.id}: ${String(err)}`);
    // Drop any buffered (un-sent) text from the failed attempt before retrying.
    turnHooks.get(userId)?.onRetry?.();
    agent.state.messages = agent.state.messages.slice(0, messagesBefore);
    agent.state.model = fallback;
    try {
      await agent.prompt(body, images);
    } catch (fallbackErr) {
      inc("iclaw_turns_total", { status: "error" });
      observe("iclaw_turn_duration_seconds", (Date.now() - startedAt) / 1000);
      throw fallbackErr;
    }
  }
  inc("iclaw_turns_total", { status: "ok" });
  observe("iclaw_turn_duration_seconds", (Date.now() - startedAt) / 1000);
  // Token-aware compression first (summarize old turns), then the hard cap.
  await maybeCompactTranscript(agent);
  const messages = trimMessages(agent.state.messages, TRANSCRIPT_MAX_MESSAGES);
  if (messages !== agent.state.messages) {
    try {
      agent.state.messages = messages;
    } catch (err) {
      logger.warn(`runtime: failed to trim in-memory transcript for ${userId}: ${String(err)}`);
    }
  }
  saveMessagesJson(userId, JSON.stringify(agent.state.messages));
  // Token/cost accounting from the provider-reported usage on this turn.
  const usage = lastAssistantUsage(agent.state.messages);
  if (usage && hasUsage(usage)) recordUsage(userId, usage);
  // Fire-and-forget long-term memory extraction (no-op unless enabled); never
  // lets a failure affect the reply.
  void extractAndRememberMemories(userId, agent.state.messages.slice(-6)).catch(() => {});
  return lastAssistantText(agent);
}
