import fs from "node:fs";

import { Agent } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";

import { loadConfig } from "../config.js";
import { getUser, loadMessagesJson, saveMessagesJson } from "../db/index.js";
import type { User } from "../db/index.js";
import type { InboundContext } from "../wechat/inbound.js";
import { buildMcpTools } from "./mcp.js";
import { getModels, resolveConfiguredModel } from "./models.js";
import { resetSkillsCache, skillsPrompt } from "./skills.js";
import { buildTools } from "./tools.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** One Agent instance per user, sharing model/tools/system-prompt shape but with isolated transcripts. */
const agents = new Map<string, Agent>();

/** Shared (non-user-bound) tools: MCP tools built once at startup. */
let sharedTools: AgentTool<any>[] = [];

/** Build the shared tool set (skills are lazy; MCP tools connect here). Call once at startup. */
export async function initSharedTools(): Promise<void> {
  resetSkillsCache();
  sharedTools = await buildMcpTools();
}

function buildSystemPrompt(user: User): string {
  const parts: string[] = [loadConfig().systemPrompt];
  if (user.persona.trim()) parts.push(`## 当前用户\n${user.persona}`);
  if (user.memory.trim()) parts.push(`## 关于当前用户的记忆\n${user.memory}`);
  const sp = skillsPrompt();
  if (sp) parts.push(sp);
  return parts.join("\n\n");
}

function fileToImageContent(filePath: string): ImageContent[] {
  const data = fs.readFileSync(filePath).toString("base64");
  return [{ type: "image", data, mimeType: "image/jpeg" }];
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

export async function getOrCreateAgent(userId: string): Promise<Agent> {
  const existing = agents.get(userId);
  if (existing) return existing;

  const user = getUser(userId);
  if (!user) throw new Error(`user not found: ${userId}`);

  const messages = JSON.parse(loadMessagesJson(userId)) as AgentMessage[];
  const models = getModels();
  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(user),
      model: resolveConfiguredModel(),
      tools: buildTools(userId, sharedTools),
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
}

export function dropAllAgents(): void {
  agents.clear();
}

/** Run one agent turn for a bound, active user. Returns the assistant's reply text. */
export async function runAgentTurn(userId: string, ctx: InboundContext): Promise<string> {
  const agent = await getOrCreateAgent(userId);
  const user = getUser(userId)!;
  // Refresh persona/memory each turn so newly-remembered facts take effect immediately.
  agent.state.systemPrompt = buildSystemPrompt(user);
  const images = ctx.media ? fileToImageContent(ctx.media.path) : undefined;
  await agent.prompt(ctx.body.trim() || "(empty)", images);
  saveMessagesJson(userId, JSON.stringify(agent.state.messages));
  return lastAssistantText(agent);
}
