import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

import { loadConfig } from "../config.js";
import { logger } from "../logger.js";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  disabled?: boolean;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

/** Load MCP server config from config.mcpConfigPath (`.mcp.json` format). */
export function loadMcpServers(): Record<string, McpServerConfig> {
  const p = loadConfig().mcpConfigPath;
  const abs = path.isAbsolute(p) ? p : path.resolve(p);
  if (!fs.existsSync(abs)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, "utf-8")) as McpConfigFile;
    return parsed.mcpServers ?? {};
  } catch (err) {
    logger.warn(`mcp: failed to read ${abs}: ${String(err)}`);
    return {};
  }
}

const clients = new Map<string, Client>();

function createTransport(name: string, cfg: McpServerConfig) {
  if (cfg.url) {
    const url = new URL(cfg.url);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return new StreamableHTTPClientTransport(url);
    }
    return new SSEClientTransport(url);
  }
  if (cfg.command) {
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env,
    });
  }
  throw new Error(`MCP server "${name}": needs either "command" (stdio) or "url" (http/sse)`);
}

async function getClient(name: string, cfg: McpServerConfig): Promise<Client> {
  const existing = clients.get(name);
  if (existing) return existing;
  const transport = createTransport(name, cfg);
  const client = new Client({ name: "iclaw", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  clients.set(name, client);
  return client;
}

function mcpResultToAgentToolResult(result: {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string; [k: string]: unknown }>;
  isError?: boolean;
}): AgentToolResult<unknown> {
  const content = (result.content ?? []).map((item) => {
    if (item.type === "text") return { type: "text" as const, text: item.text ?? "" };
    if (item.type === "image") return { type: "image" as const, data: item.data ?? "", mimeType: item.mimeType ?? "image/png" };
    return { type: "text" as const, text: JSON.stringify(item) };
  });
  if (content.length === 0) content.push({ type: "text", text: result.isError ? "(mcp error)" : "(empty result)" });
  return { content, details: {} };
}

/** Build one native AgentTool per MCP tool across all enabled servers. */
export async function buildMcpTools(): Promise<AgentTool<any>[]> {
  const servers = loadMcpServers();
  const out: AgentTool<any>[] = [];
  for (const [serverName, cfg] of Object.entries(servers)) {
    if (cfg.disabled) continue;
    try {
      const client = await getClient(serverName, cfg);
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const toolName = `mcp_${serverName}_${tool.name}`;
        const schema = (tool.inputSchema ?? {}) as Record<string, unknown>;
        out.push({
          name: toolName,
          label: toolName,
          description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
          parameters: Type.Unsafe(schema),
          execute: async (_id, params) => {
            const result = await client.callTool({ name: tool.name, arguments: (params ?? {}) as Record<string, unknown> });
            return mcpResultToAgentToolResult(result as Parameters<typeof mcpResultToAgentToolResult>[0]);
          },
        });
      }
      logger.info(`mcp: server "${serverName}" registered ${tools.length} tool(s)`);
    } catch (err) {
      logger.warn(`mcp: failed to connect to server "${serverName}": ${String(err)}`);
    }
  }
  return out;
}

export interface McpServerStatus {
  name: string;
  configured: boolean;
  error?: string;
  tools: string[];
}

/** Persist a new `mcpServers` map to config.mcpConfigPath (used by the admin UI). */
export function saveMcpServers(servers: Record<string, McpServerConfig>): void {
  const p = loadConfig().mcpConfigPath;
  const abs = path.isAbsolute(p) ? p : path.resolve(p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  let existing: McpConfigFile = {};
  try {
    existing = JSON.parse(fs.readFileSync(abs, "utf-8")) as McpConfigFile;
  } catch {
    // missing / invalid
  }
  fs.writeFileSync(abs, JSON.stringify({ ...existing, mcpServers: servers }, null, 2), "utf-8");
}

/** Health + tool listing for the web admin. */
export async function listMcpServerStatus(): Promise<McpServerStatus[]> {
  const servers = loadMcpServers();
  const out: McpServerStatus[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.disabled) {
      out.push({ name, configured: false, tools: [] });
      continue;
    }
    try {
      const client = await getClient(name, cfg);
      const { tools } = await client.listTools();
      out.push({ name, configured: true, tools: tools.map((t) => t.name) });
    } catch (err) {
      out.push({ name, configured: false, error: String(err), tools: [] });
    }
  }
  return out;
}
