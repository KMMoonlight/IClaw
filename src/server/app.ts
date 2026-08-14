import fs from "node:fs";
import path from "node:path";

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";

import { initSharedTools } from "../agent/runtime.js";
import { listMcpServerStatus, loadMcpServers, saveMcpServers } from "../agent/mcp.js";
import { loadSkills, resetSkillsCache } from "../agent/skills.js";
import { createBotHandler } from "../bot.js";
import { loadConfig } from "../config.js";
import {
  countAdmins,
  createAdmin,
  createInvite,
  createUser,
  getAdminByUsername,
  getUser,
  listBindings,
  listInvites,
  listUsers,
  setUserMemory,
  setUserPersona,
  setUserStatus,
} from "../db/index.js";
import { generateInviteCode } from "../random.js";
import { listIndexedWeixinAccountIds } from "../wechat/accounts.js";
import { startWechatChannel } from "../wechat/channel.js";
import { logger } from "../logger.js";
import { generateAdminPassword, hashPassword, signSession, verifyPassword, verifySession } from "./auth.js";

const COOKIE_NAME = "iclaw_session";

function buildApp() {
  const app = Fastify({ logger: false });
  app.register(cookie);

  // Serve the built SPA (web:build -> dist/public) when present.
  const publicDir = path.resolve("dist/public");
  if (fs.existsSync(publicDir)) {
    app.register(fastifyStatic, { root: publicDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  const authGuard = async (req: any, reply: any) => {
    if (!verifySession(req.cookies?.[COOKIE_NAME])) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };

  // --- auth -------------------------------------------------------------
  app.post("/api/auth/login", async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const admin = getAdminByUsername(username ?? "");
    if (!admin || !verifyPassword(password ?? "", admin.passwordHash)) {
      return reply.code(401).send({ error: "invalid credentials" });
    }
    reply.setCookie(COOKIE_NAME, signSession(admin.username), { httpOnly: true, sameSite: "strict", path: "/" });
    return { ok: true, username: admin.username };
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: authGuard }, async (req) => {
    return { username: verifySession(req.cookies[COOKIE_NAME]) };
  });

  // --- users ------------------------------------------------------------
  app.get("/api/users", { preHandler: authGuard }, async () => {
    const bindings = listBindings();
    return listUsers().map((u) => ({
      ...u,
      binding: bindings.find((b) => b.userId === u.id)?.wechatId ?? null,
    }));
  });

  app.post("/api/users", { preHandler: authGuard }, async (req, reply) => {
    const { name, persona } = (req.body ?? {}) as { name?: string; persona?: string };
    if (!name?.trim()) return reply.code(400).send({ error: "name is required" });
    return createUser(name.trim(), persona?.trim() ?? "");
  });

  app.patch("/api/users/:id", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = getUser(id);
    if (!user) return reply.code(404).send({ error: "user not found" });
    const body = (req.body ?? {}) as { persona?: string; memory?: string; status?: "active" | "frozen" };
    if (body.persona !== undefined) setUserPersona(id, body.persona);
    if (body.memory !== undefined) setUserMemory(id, body.memory);
    if (body.status !== undefined) setUserStatus(id, body.status);
    return getUser(id);
  });

  app.post("/api/users/:id/invite", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });
    const code = generateInviteCode();
    createInvite(code, id);
    return { code, userId: id };
  });

  app.get("/api/invites", { preHandler: authGuard }, async () => listInvites());

  // --- skills -----------------------------------------------------------
  app.get("/api/skills", { preHandler: authGuard }, async () => {
    return loadSkills().map((s) => ({ name: s.name, description: s.description }));
  });

  app.post("/api/skills", { preHandler: authGuard }, async (req, reply) => {
    const { name, description, body } = (req.body ?? {}) as { name?: string; description?: string; body?: string };
    if (!name?.trim() || !body?.trim()) return reply.code(400).send({ error: "name and body are required" });
    const safe = name.trim().replace(/[^\w-]/g, "-");
    const dir = path.isAbsolute(loadConfig().skillsDir) ? loadConfig().skillsDir : path.resolve(loadConfig().skillsDir);
    const skillDir = path.join(dir, safe);
    fs.mkdirSync(skillDir, { recursive: true });
    const frontmatter = `---\nname: ${safe}\ndescription: ${(description ?? "").trim()}\n---\n\n`;
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), frontmatter + body.trim() + "\n");
    resetSkillsCache();
    return { name: safe };
  });

  app.delete("/api/skills/:name", { preHandler: authGuard }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const dir = path.isAbsolute(loadConfig().skillsDir) ? loadConfig().skillsDir : path.resolve(loadConfig().skillsDir);
    const target = path.join(dir, name.replace(/[^\w-]/g, "-"));
    if (!target.startsWith(path.resolve(dir)) || !fs.existsSync(target)) {
      return reply.code(404).send({ error: "skill not found" });
    }
    fs.rmSync(target, { recursive: true, force: true });
    resetSkillsCache();
    return { ok: true };
  });

  // --- mcp --------------------------------------------------------------
  app.get("/api/mcp", { preHandler: authGuard }, async () => {
    const servers = loadMcpServers();
    const status = await listMcpServerStatus();
    return { servers, status };
  });

  app.put("/api/mcp", { preHandler: authGuard }, async (req) => {
    const body = (req.body ?? {}) as { servers?: Record<string, unknown> };
    saveMcpServers((body.servers ?? {}) as Record<string, never>);
    return { ok: true };
  });

  return app;
}

function ensureAdmin(): void {
  if (countAdmins() > 0) return;
  const cfg = loadConfig();
  const password = process.env.ICLAW_ADMIN_PASSWORD ?? generateAdminPassword();
  createAdmin(cfg.adminUser, hashPassword(password));
  logger.warn(`已创建管理员账号：${cfg.adminUser}`);
  logger.warn(`管理员密码：${password}（请立即登录并妥善保管；可用环境变量 ICLAW_ADMIN_PASSWORD 覆盖）`);
}

function startChannelBackground(): void {
  void (async () => {
    const ids = listIndexedWeixinAccountIds();
    if (ids.length === 0) {
      logger.warn("无已登录微信账号，跳过微信通道启动（先运行 `iclaw login`）。");
      return;
    }
    const abort = new AbortController();
    process.on("SIGINT", () => abort.abort());
    process.on("SIGTERM", () => abort.abort());
    await startWechatChannel({ onMessage: createBotHandler(), abortSignal: abort.signal });
  })().catch((err) => logger.error(`微信通道异常：${String(err)}`));
}

export async function startServer(): Promise<void> {
  await initSharedTools();
  ensureAdmin();
  const app = buildApp();
  const { host, port } = loadConfig().server;
  await app.listen({ host, port });
  logger.info(`管理端已启动：http://${host}:${port}`);
  startChannelBackground();
}
