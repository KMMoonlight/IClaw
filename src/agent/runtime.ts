import fs from "node:fs";

import { Agent } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";

import { loadConfig } from "../config.js";
import { clearUserSession, getUser, loadMessagesJson, saveMessagesJson } from "../db/index.js";
import { logger } from "../logger.js";
import type { User } from "../db/index.js";
import type { InboundContext } from "../wechat/inbound.js";
import { buildMcpTools, resetMcpClients } from "./mcp.js";
import { getModels, resolveConfiguredModel, supportsImages } from "./models.js";
import { resetSkillsCache, skillsPrompt } from "./skills.js";
import { buildTools } from "./tools.js";
import { maybeCompactTranscript, trimMessages, TRANSCRIPT_MAX_MESSAGES } from "./transcript.js";

/** One Agent instance per user, sharing model/tools/system-prompt shape but with isolated transcripts. */
const agents = new Map<string, Agent>();
/** Last time each agent processed a turn, for idle eviction. */
const lastUsed = new Map<string, number>();
/** Per-user turn chains: Agent.prompt rejects concurrent calls, so turns for one user run one at a time. */
const turnChains = new Map<string, Promise<unknown>>();

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

function buildSystemPrompt(user: User, tools: AgentTool<any>[]): string {
  const parts: string[] = [loadConfig().systemPrompt];
  if (user.persona.trim()) parts.push(`## 当前用户\n${user.persona}`);
  if (user.memory.trim()) parts.push(`## 关于当前用户的记忆\n${user.memory}`);
  const sp = skillsPrompt();
  if (sp) parts.push(sp);
  const toolNames = [...new Set(tools.map((t) => t.name))];
  parts.push(`## 当前可用工具\n${toolNames.join(", ")}`);
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
      systemPrompt: buildSystemPrompt(user, tools),
      model: resolveConfiguredModel(),
      tools,
      messages,
    },
    streamFn: models.streamSimple.bind(models),
    sessionId: userId,
  });
  agents.set(userId, agent);
  return agent;
}

export function dropAgent(userId: string): void {
  agents.delete(userId);
  lastUsed.delete(userId);
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
export function runAgentTurn(userId: string, ctx: InboundContext): Promise<string> {
  const prev = turnChains.get(userId) ?? Promise.resolve();
  const next = prev.then(() => runAgentTurnInner(userId, ctx));
  // Keep the chain alive even after failures; the caller receives the real error.
  turnChains.set(userId, next.catch(() => undefined));
  return next;
}

async function runAgentTurnInner(userId: string, ctx: InboundContext): Promise<string> {
  const agent = await getOrCreateAgent(userId);
  lastUsed.set(userId, Date.now());
  const user = getUser(userId)!;
  // Refresh persona/memory each turn so newly-remembered facts take effect immediately.
  agent.state.systemPrompt = buildSystemPrompt(user, agent.state.tools);

  let body = ctx.body.trim() || "(empty)";
  let images: ImageContent[] | undefined;
  if (ctx.media) {
    if (supportsImages()) {
      images = fileToImageContent(ctx.media.path, ctx.media.type);
    } else {
      body = `[图片消息：当前模型不支持图片输入]\n${body}`;
    }
  }

  await agent.prompt(body, images);
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
  return lastAssistantText(agent);
}
