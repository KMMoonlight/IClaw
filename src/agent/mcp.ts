import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { z } from "zod";

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

/** Placeholder used in API responses in place of secret env values. */
export const SECRET_MASK = "***";

/** Mask credentials embedded in a URL's userinfo (`scheme://user:pass@host`). */
export function maskUrlSecrets(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@?#]+)@/i, `$1${SECRET_MASK}@`);
}

/**
 * Mask `--flag=secret` style command args. Only flags whose name *starts a word*
 * segment with a secret-ish keyword are masked, so e.g. `--monkey=...` is left
 * alone while `--token=`, `--api-key=`, `--access-key-id=` are masked.
 */
export function maskArgSecrets(arg: string): string {
  return arg.replace(
    /(?<!\w)(token|api[-_]?key|secret|password|passwd|auth)([-_][\w.-]*)?=(\S+)/gi,
    (_match, name: string, suffix: string | undefined) => `${name}${suffix ?? ""}=${SECRET_MASK}`,
  );
}

/** Return a copy of the server map with secrets (env values, URL userinfo, args) masked. */
export function maskMcpServers(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    const copy: McpServerConfig = { ...cfg };
    if (cfg.env) copy.env = Object.fromEntries(Object.keys(cfg.env).map((k) => [k, SECRET_MASK]));
    if (typeof copy.url === "string") copy.url = maskUrlSecrets(copy.url);
    if (Array.isArray(copy.args)) copy.args = copy.args.map(maskArgSecrets);
    out[name] = copy;
  }
  return out;
}

/**
 * Merge incoming (possibly masked) servers with the stored ones so that a
 * round-tripped `"***"` value keeps the existing secret instead of wiping it.
 */
export function mergeMaskedSecrets(
  incoming: Record<string, McpServerConfig>,
  existing: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(incoming)) {
    const merged: McpServerConfig = { ...cfg };
    const prior = existing[name];
    if (cfg.env) {
      const prevEnv = prior?.env ?? {};
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(cfg.env)) {
        if (v === SECRET_MASK) {
          if (prevEnv[k] !== undefined) env[k] = prevEnv[k];
        } else {
          env[k] = v;
        }
      }
      merged.env = env;
    }
    // Restore a masked URL userinfo when the client round-trips the masked value.
    if (typeof cfg.url === "string" && typeof prior?.url === "string" && cfg.url === maskUrlSecrets(prior.url)) {
      merged.url = prior.url;
    }
    // Restore masked secrets inside `--flag=secret` args positionally.
    if (cfg.args && prior?.args && cfg.args.length === prior.args.length) {
      merged.args = cfg.args.map((arg, i) => (arg === maskArgSecrets(prior.args![i]!) ? prior.args![i]! : arg));
    }
    out[name] = merged;
  }
  return out;
}

/** Runtime validation for the PUT /api/mcp body (admin UI saves mcp.json). */
export const mcpServersSchema = z
  .object({
    servers: z
      .record(
        z.string().min(1),
        z
          .object({
            command: z.string().min(1).optional(),
            args: z.array(z.string()).optional(),
            url: z.string().url().optional(),
            env: z.record(z.string(), z.string()).optional(),
            disabled: z.boolean().optional(),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();

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

/** Environment variables forwarded to stdio MCP servers (never secrets). */
export const MCP_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "NODE_PATH",
  "NVM_DIR",
  "NVM_BIN",
  "NVM_INC",
  "PNPM_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "APPDATA",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "ProgramFiles",
] as const;

/** Build the child env for a stdio MCP server: safe allowlist + per-server vars. */
export function buildMcpEnv(
  parent: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MCP_ENV_ALLOWLIST) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

const clients = new Map<string, Client>();

/** Close and forget all connected MCP clients (for config hot-reload). */
export function resetMcpClients(): void {
  for (const client of clients.values()) {
    void client.close().catch(() => {});
  }
  clients.clear();
}

function createTransport(name: string, cfg: McpServerConfig) {
  if (cfg.url) {
    const url = new URL(cfg.url);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return new StreamableHTTPClientTransport(url);
    }
    return new SSEClientTransport(url);
  }
  if (cfg.command) {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      // Only pass a safe allowlist of parent env (plus the server's own vars) to
      // stdio servers, so ICLAW secrets never leak into third-party processes.
      env: buildMcpEnv(process.env, cfg.env),
      stderr: "pipe",
    });
    // Surface child stderr in our logs for diagnostics ("Connection closed" etc.).
    if (transport.stderr) {
      transport.stderr.on("data", (chunk: Buffer) => {
        logger.debug(`mcp "${name}" stderr: ${String(chunk).trim()}`);
      });
    }
    return transport;
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
