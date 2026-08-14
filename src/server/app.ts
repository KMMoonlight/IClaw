import fs from "node:fs";
import path from "node:path";

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import QRCode from "qrcode";
import { z } from "zod";

import { dropAgent, initSharedTools } from "../agent/runtime.js";
import { listMcpServerStatus, loadMcpServers, saveMcpServers, mcpServersSchema } from "../agent/mcp.js";
import { loadSkills, resetSkillsCache } from "../agent/skills.js";
import { createBotHandler } from "../bot.js";
import { loadConfig } from "../config.js";
import {
  countAdmins,
  createAdmin,
  createUser,
  getAdminByUsername,
  getBindingByUser,
  getUser,
  listBotBindings,
  listUsers,
  setUserMemory,
  setUserPersona,
  setUserStatus,
} from "../db/index.js";
import { persistAndBind, unbindUserBot } from "../wechat/binding.js";
import { runBindSession, stopBindDriver } from "../wechat/bind-driver.js";
import {
  listRunningChannels,
  startChannelForAccount,
  startChannelsForBoundAccounts,
  stopAllChannels,
  stopChannelForAccount,
} from "../wechat/channel.js";
import { listIndexedWeixinAccountIds } from "../wechat/accounts.js";
import { cancelLoginSession, getLoginSession, startLoginSession, submitVerifyCode } from "../wechat/login-qr.js";
import { logger } from "../logger.js";
import { generateAdminPassword, hashPassword, signSession, verifyPassword, verifySession } from "./auth.js";

const COOKIE_NAME = "iclaw_session";

const userPatchSchema = z
  .object({
    persona: z.string().optional(),
    memory: z.string().optional(),
    status: z.enum(["active", "frozen"]).optional(),
  })
  .strict();

const verifyCodeSchema = z.object({ code: z.string().min(1).max(16) }).strict();

// --- login rate limiting (fixed window per IP) -----------------------------

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;
const loginAttempts = new Map<string, { count: number; windowStart: number }>();

function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.windowStart > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
  const entry = loginAttempts.get(ip);
  if (!entry) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

// --- bind sessions (one per user) -------------------------------------------

const bindDrivers = new Map<string, AbortController>();

async function qrSvgFor(qrcodeUrl: string | undefined): Promise<string | null> {
  if (!qrcodeUrl) return null;
  return QRCode.toString(qrcodeUrl, { type: "svg", margin: 1, width: 280 });
}

function buildApp(botHandler: (ctx: import("../wechat/inbound.js").InboundContext) => Promise<void>) {
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
    if (loginRateLimited(req.ip)) {
      return reply.code(429).send({ error: "too many attempts, try again later" });
    }
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const admin = getAdminByUsername(username ?? "");
    if (!admin || !verifyPassword(password ?? "", admin.passwordHash)) {
      return reply.code(401).send({ error: "invalid credentials" });
    }
    reply.setCookie(COOKIE_NAME, signSession(admin.username), {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      secure: loadConfig().cookieSecure,
    });
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
    return listUsers().map((u) => {
      const binding = getBindingByUser(u.id);
      return {
        ...u,
        botAccount: binding?.accountId ?? null,
        wechatUserId: binding?.wechatUserId ?? null,
      };
    });
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
    const parsed = userPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid body", details: parsed.error.flatten() });
    }
    const body = parsed.data;
    if (body.persona !== undefined) setUserPersona(id, body.persona);
    if (body.memory !== undefined) setUserMemory(id, body.memory);
    if (body.status !== undefined) {
      setUserStatus(id, body.status);
      if (body.status === "frozen") dropAgent(id); // free memory; rebuilt on unfreeze
    }
    return getUser(id);
  });

  // --- bind（扫码即绑定）--------------------------------------------------
  app.post("/api/users/:id/bind", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });

    // Restart: cancel any in-flight session/driver for this user.
    stopBindDriver(id);
    cancelLoginSession(`user-${id}`);
    bindDrivers.get(id)?.abort();

    const key = `user-${id}`;
    const session = await startLoginSession({ key, force: true });
    if (session.phase !== "wait" || !session.qrcodeUrl) {
      return reply.code(502).send({ error: session.message });
    }

    const controller = new AbortController();
    bindDrivers.set(id, controller);
    void runBindSession({
      key,
      signal: controller.signal,
      onConnected: async (s) => {
        const accountId = persistAndBind(s, id, { onReplaced: (old) => stopChannelForAccount(old) });
        startChannelForAccount(accountId, botHandler);
      },
    }).finally(() => bindDrivers.delete(id));

    return { ...session, qrSvg: await qrSvgFor(session.qrcodeUrl) };
  });

  app.get("/api/users/:id/bind/status", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const key = `user-${id}`;
    const session = getLoginSession(key);
    if (!session) {
      const binding = getBindingByUser(id);
      if (binding) return { connected: true, phase: "connected", message: "已绑定。", bound: true };
      return { phase: "idle", message: "尚未发起绑定。", connected: false, bound: false };
    }
    return { ...session, qrSvg: await qrSvgFor(session.qrcodeUrl), bound: Boolean(getBindingByUser(id)) };
  });

  app.post("/api/users/:id/bind/verify", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = verifyCodeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    submitVerifyCode(`user-${id}`, parsed.data.code);
    return { ok: true };
  });

  app.post("/api/users/:id/bind/cancel", { preHandler: authGuard }, async (req) => {
    const { id } = req.params as { id: string };
    stopBindDriver(id);
    cancelLoginSession(`user-${id}`);
    bindDrivers.get(id)?.abort();
    return { ok: true };
  });

  app.post("/api/users/:id/unbind", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });
    const removed = unbindUserBot(id, { onRemoved: (accountId) => stopChannelForAccount(accountId) });
    if (!removed) return reply.code(404).send({ error: "user has no bot binding" });
    return { ok: true };
  });

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

  app.put("/api/mcp", { preHandler: authGuard }, async (req, reply) => {
    const parsed = mcpServersSchema.safeParse((req.body ?? {}) as { servers?: unknown });
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid body", details: parsed.error.flatten() });
    }
    saveMcpServers(parsed.data.servers);
    return { ok: true };
  });

  // --- wechat accounts / channels (admin diagnostics) --------------------
  app.get("/api/wechat/accounts", { preHandler: authGuard }, async () => {
    const bindings = listBotBindings();
    const ids = [...new Set([...listIndexedWeixinAccountIds(), ...bindings.map((b) => b.accountId)])];
    return ids.map((accountId) => {
      const binding = bindings.find((b) => b.accountId === accountId);
      return {
        accountId,
        running: listRunningChannels().includes(accountId),
        userId: binding?.userId ?? null,
        wechatUserId: binding?.wechatUserId ?? null,
      };
    });
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

export async function startServer(): Promise<void> {
  await initSharedTools();
  ensureAdmin();
  const app = buildApp(createBotHandler());
  const { host, port } = loadConfig().server;
  await app.listen({ host, port });
  logger.info(`管理端已启动：http://${host}:${port}`);

  // Start channels for already-bound bot accounts; new binds start their own.
  startChannelsForBoundAccounts(createBotHandler());

  const shutdown = () => {
    stopAllChannels();
    void app.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
