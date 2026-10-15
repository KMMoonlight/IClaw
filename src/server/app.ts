import fs from "node:fs";
import path from "node:path";

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import QRCode from "qrcode";
import { z } from "zod";

import { dropAgent, initSharedTools, reloadSharedTools, resetUserSession } from "../agent/runtime.js";
import { waitForIdle } from "../agent/inflight.js";
import { consolidateAllUsers, consolidateMemories } from "../agent/memory-consolidate.js";
import { handleWatcherChange, runScheduledTask } from "../scheduler/deliver.js";
import { startScheduler, stopScheduler } from "../scheduler/scheduler.js";
import { runWatchers } from "../scheduler/triggers.js";
import { listMcpServerStatus, loadMcpServers, saveMcpServers, mcpServersSchema, maskMcpServers, mergeMaskedSecrets } from "../agent/mcp.js";
import { installSkillFromGithub, getSkill, loadSkills, resetSkillsCache } from "../agent/skills.js";
import { createBotHandler } from "../bot.js";
import { loadConfig } from "../config.js";
import {
  addMemory,
  clearUserMemories,
  createAdmin,
  createInvite,
  createUser,
  deleteMemory,
  deleteUserData,
  exportUserData,
  getAdminByUsername,
  getAdminRole,
  getBindingByUser,
  getActiveSessionId,
  getSessionDetail,
  getInvite,
  getMemory,
  getUser,
  getUserUsageForDay,
  getUserUsageTotal,
  listBotBindings,
  listAudit,
  listMemories,
  listInvites,
  listUsageTotals,
  listUsers,
  localDay,
  listAdmins,
  listSessions,
  listSkillSettings,
  markInviteUsed,
  purgeOldData,
  recordAudit,
  roleAtLeast,
  setAdminRole,
  setSkillEnabled,
  setAdminPassword,
  setUserDisabledTools,
  setUserDisabledSkills,
  setUserModel,
  setUserPersona,
  setUserStatus,
  splitLegacyMemory,
  updateMemory,
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
import { renderPrometheus } from "../metrics.js";
import { generateAdminPassword, hashPassword, signSession, verifyPassword, verifySession } from "./auth.js";

const COOKIE_NAME = "iclaw_session";

const userPatchSchema = z
  .object({
    persona: z.string().optional(),
    memory: z.string().optional(),
    status: z.enum(["active", "frozen"]).optional(),
    disabledTools: z.array(z.string().min(1).max(64)).max(200).optional(),
    disabledSkills: z.array(z.string().min(1).max(128)).max(200).optional(),
    model: z.string().max(200).optional(),
  })
  .strict();

const verifyCodeSchema = z.object({ code: z.string().min(1).max(16) }).strict();
const skillInstallSchema = z.object({ url: z.string().min(1).max(200) }).strict();
const adminRoleSchema = z.object({ role: z.enum(["viewer", "admin", "owner"]) }).strict();
const skillEnabledSchema = z.object({ enabled: z.boolean() }).strict();

const memoryCreateSchema = z
  .object({
    content: z.string().min(1).max(4000),
    kind: z.enum(["fact", "preference", "event", "profile"]).optional(),
    importance: z.number().min(0).max(1).optional(),
  })
  .strict();

const memoryPatchSchema = z
  .object({
    content: z.string().min(1).max(4000).optional(),
    kind: z.enum(["fact", "preference", "event", "profile"]).optional(),
    importance: z.number().min(0).max(1).optional(),
  })
  .strict();

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

export function buildApp(botHandler: (ctx: import("../wechat/inbound.js").InboundContext) => Promise<void>) {
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
    const username = verifySession(req.cookies?.[COOKIE_NAME]);
    if (!username) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const role = getAdminRole(username);
    req.adminUser = username;
    req.adminRole = role;
    // Viewers are read-only; any mutating request needs at least the admin role.
    if (req.method !== "GET" && !roleAtLeast(role, "admin")) {
      return reply.code(403).send({ error: "forbidden" });
    }
  };

  const ownerGuard = async (req: any, reply: any) => {
    if (req.adminRole !== "owner") return reply.code(403).send({ error: "forbidden" });
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

  app.get("/api/auth/me", { preHandler: authGuard }, async (req: any) => {
    return { username: req.adminUser, role: req.adminRole };
  });

  // --- admins / roles (owner only) --------------------------------------
  app.get("/api/admins", { preHandler: [authGuard, ownerGuard] }, async () => {
    return listAdmins().map((a) => ({ username: a.username, role: a.role, createdAt: a.createdAt }));
  });

  app.patch("/api/admins/:username", { preHandler: [authGuard, ownerGuard] }, async (req, reply) => {
    const { username } = req.params as { username: string };
    const parsed = adminRoleSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid body", details: parsed.error.flatten() });
    if (!getAdminByUsername(username)) return reply.code(404).send({ error: "admin not found" });
    setAdminRole(username, parsed.data.role);
    recordAudit({ actor: "admin", action: "admin.setRole", detail: `${username}=${parsed.data.role}` });
    return { ok: true };
  });

  // --- health (unauthenticated, for orchestrators / LB probes) ------------
  app.get("/api/health", async () => {
    return { ok: true, channels: listRunningChannels().length };
  });

  // --- metrics (Prometheus text; unauthenticated, counters only) ---------
  app.get("/metrics", async (_req, reply) => {
    return reply.type("text/plain; version=0.0.4").send(renderPrometheus());
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
    const user = createUser(name.trim(), persona?.trim() ?? "");
    recordAudit({ actor: "admin", userId: user.id, action: "user.create", detail: user.name });
    return user;
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
    if (body.memory !== undefined) {
      // Legacy write-through: `memory` is the old free-form string. It now
      // replaces the structured memory set instead of the deprecated column.
      clearUserMemories(id);
      for (const fact of splitLegacyMemory(body.memory)) {
        addMemory(id, fact, { source: "admin" });
      }
    }
    if (body.status !== undefined) {
      setUserStatus(id, body.status);
      if (body.status === "frozen") dropAgent(id); // free memory; rebuilt on unfreeze
    }
    if (body.disabledTools !== undefined) {
      setUserDisabledTools(id, body.disabledTools);
      dropAgent(id); // rebuild the tool set on the next turn
    }
    if (body.disabledSkills !== undefined) {
      setUserDisabledSkills(id, body.disabledSkills);
      dropAgent(id);
    }
    if (body.model !== undefined) {
      setUserModel(id, body.model.trim());
      dropAgent(id); // rebuild with the new model on the next turn
    }
    recordAudit({ actor: "admin", userId: id, action: "user.patch", detail: Object.keys(body).join(",") });
    return getUser(id);
  });

  // --- bind（扫码即绑定）--------------------------------------------------
  /** Start (or restart) a login/QR session for a user and begin the bind driver. */
  async function beginBind(userId: string) {
    stopBindDriver(userId);
    cancelLoginSession(`user-${userId}`);
    bindDrivers.get(userId)?.abort();

    const key = `user-${userId}`;
    const session = await startLoginSession({ key, force: true });
    if (session.phase !== "wait" || !session.qrcodeUrl) return null;

    const controller = new AbortController();
    bindDrivers.set(userId, controller);
    void runBindSession({
      key,
      signal: controller.signal,
      onConnected: async (s) => {
        const accountId = persistAndBind(s, userId, { onReplaced: (old) => stopChannelForAccount(old) });
        startChannelForAccount(accountId, botHandler);
      },
    }).finally(() => bindDrivers.delete(userId));

    return { ...session, qrSvg: await qrSvgFor(session.qrcodeUrl) };
  }

  app.post("/api/users/:id/bind", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });
    const result = await beginBind(id);
    if (!result) return reply.code(502).send({ error: "微信登录未就绪，请重试" });
    return result;
  });

  // --- invites & self-service onboarding --------------------------------
  app.post("/api/invites", { preHandler: authGuard }, async (req) => {
    const { note } = (req.body ?? {}) as { note?: string };
    const invite = createInvite((note ?? "").trim().slice(0, 200));
    recordAudit({ actor: "admin", action: "invite.create", detail: invite.code });
    return invite;
  });

  app.get("/api/invites", { preHandler: authGuard }, async () => {
    return listInvites();
  });

  // Public: check whether an invite code is usable.
  app.get("/api/onboard/:code", async (req, reply) => {
    const { code } = req.params as { code: string };
    const invite = getInvite(code);
    if (!invite) return reply.code(404).send({ valid: false, reason: "invalid" });
    if (invite.usedBy) return reply.code(409).send({ valid: false, reason: "used" });
    return { valid: true };
  });

  // Public: redeem an invite → create a user and return a bind QR.
  app.post("/api/onboard/:code", async (req, reply) => {
    if (loginRateLimited(req.ip)) return reply.code(429).send({ error: "too many attempts, try again later" });
    const { code } = req.params as { code: string };
    const invite = getInvite(code);
    if (!invite) return reply.code(404).send({ error: "invalid invite" });
    if (invite.usedBy) return reply.code(409).send({ error: "invite already used" });

    const { name, persona } = (req.body ?? {}) as { name?: string; persona?: string };
    const user = createUser(name?.trim().slice(0, 64) || `用户-${code.slice(0, 4)}`, persona?.trim().slice(0, 500) ?? "");

    const result = await beginBind(user.id);
    if (!result) {
      // Don't consume the invite or leave an orphan user when WeChat isn't ready.
      deleteUserData(user.id);
      return reply.code(502).send({ error: "微信登录未就绪，请重试" });
    }
    if (!markInviteUsed(code, user.id)) {
      // Lost a concurrent redeem race; roll back the user and the bind driver we started.
      stopBindDriver(user.id);
      cancelLoginSession(`user-${user.id}`);
      bindDrivers.get(user.id)?.abort();
      deleteUserData(user.id);
      return reply.code(409).send({ error: "invite already used" });
    }
    recordAudit({ actor: "system", userId: user.id, action: "user.selfOnboard" });
    return { userId: user.id, ...result };
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
    recordAudit({ actor: "admin", userId: id, action: "user.unbind" });
    return { ok: true };
  });

  app.post("/api/users/:id/session/reset", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });
    resetUserSession(id);
    return { ok: true };
  });

  // --- memories（结构化长期记忆）----------------------------------------
  app.get("/api/users/:id/memories", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });
    return listMemories(id);
  });

  app.post("/api/users/:id/memories", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });
    const parsed = memoryCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid body", details: parsed.error.flatten() });
    }
    const { content, kind, importance } = parsed.data;
    return addMemory(id, content.trim(), { source: "admin", kind, importance });
  });

  app.patch("/api/memories/:memoryId", { preHandler: authGuard }, async (req, reply) => {
    const { memoryId } = req.params as { memoryId: string };
    if (!getMemory(memoryId)) return reply.code(404).send({ error: "memory not found" });
    const parsed = memoryPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid body", details: parsed.error.flatten() });
    }
    return updateMemory(memoryId, parsed.data);
  });

  app.delete("/api/memories/:memoryId", { preHandler: authGuard }, async (req, reply) => {
    const { memoryId } = req.params as { memoryId: string };
    if (!deleteMemory(memoryId)) return reply.code(404).send({ error: "memory not found" });
    return { ok: true };
  });

  app.delete("/api/users/:id/memories", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });
    return { ok: true, removed: clearUserMemories(id) };
  });

  app.post("/api/users/:id/memories/consolidate", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });
    return consolidateMemories(id);
  });

  app.post("/api/memories/consolidate", { preHandler: authGuard }, async () => {
    return { results: consolidateAllUsers() };
  });

  // --- usage（token / 费用）------------------------------------------------
  app.get("/api/users/:id/usage", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });
    return { total: getUserUsageTotal(id), today: getUserUsageForDay(id) };
  });

  app.get("/api/usage", { preHandler: authGuard }, async () => {
    return { day: localDay(), totals: listUsageTotals() };
  });

  // --- audit log --------------------------------------------------------
  app.get("/api/audit", { preHandler: authGuard }, async (req) => {
    const query = req.query as { limit?: string; userId?: string };
    const parsedLimit = query.limit ? Number(query.limit) : undefined;
    return { entries: listAudit({ limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined, userId: query.userId }) };
  });

  // --- sessions (history / replay) --------------------------------------
  app.get("/api/users/:id/sessions", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });
    return { sessions: listSessions(id), active: getActiveSessionId(id) };
  });

  app.get("/api/sessions/:sessionId", { preHandler: authGuard }, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const detail = getSessionDetail(sessionId);
    if (!detail) return reply.code(404).send({ error: "session not found" });
    return detail;
  });

  // --- data lifecycle (export / delete) ---------------------------------
  app.get("/api/users/:id/export", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });
    recordAudit({ actor: "admin", userId: id, action: "data.export" });
    return exportUserData(id);
  });

  app.delete("/api/users/:id", { preHandler: authGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: "user not found" });
    const binding = getBindingByUser(id);
    if (binding) stopChannelForAccount(binding.accountId);
    dropAgent(id);
    const removed = deleteUserData(id);
    recordAudit({ actor: "admin", action: "user.delete", detail: `sessions=${removed.sessions} memories=${removed.memories}` });
    return { ok: true, removed };
  });

  // --- skills -----------------------------------------------------------
  app.get("/api/skills", { preHandler: authGuard }, async () => {
    const settings = new Map(listSkillSettings().map((s) => [s.name, s]));
    return loadSkills().map((s) => ({
      name: s.name,
      description: s.description,
      version: s.version ?? null,
      enabled: settings.get(s.name)?.enabled ?? true,
    }));
  });

  app.patch("/api/skills/:name", { preHandler: authGuard }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const skill = getSkill(name);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    const parsed = skillEnabledSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid body", details: parsed.error.flatten() });
    setSkillEnabled(name, parsed.data.enabled, skill.version ?? null);
    recordAudit({ actor: "admin", action: "skill.toggle", detail: `${name}=${parsed.data.enabled}` });
    return { ok: true };
  });

  app.post("/api/skills", { preHandler: authGuard }, async (req, reply) => {
    const { name, description, body } = (req.body ?? {}) as { name?: string; description?: string; body?: string };
    if (!name?.trim() || !body?.trim()) return reply.code(400).send({ error: "name and body are required" });
    const safe = name.trim().replace(/[^\w-]/g, "-");
    const dir = path.isAbsolute(loadConfig().skillsDir) ? loadConfig().skillsDir : path.resolve(loadConfig().skillsDir);
    const skillDir = path.join(dir, safe);
    fs.mkdirSync(skillDir, { recursive: true });
    // Collapse newlines so the description cannot inject extra frontmatter fields.
    const desc = (description ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 500);
    const frontmatter = `---\nname: ${safe}\ndescription: ${desc}\n---\n\n`;
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), frontmatter + body.trim() + "\n");
    resetSkillsCache();
    return { name: safe };
  });

  app.post("/api/skills/install", { preHandler: authGuard }, async (req, reply) => {
    const parsed = skillInstallSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid body", details: parsed.error.flatten() });
    }
    try {
      const result = await installSkillFromGithub(parsed.data.url);
      recordAudit({ actor: "admin", action: "skill.install", detail: parsed.data.url });
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
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
    return { servers: maskMcpServers(servers), status };
  });

  app.put("/api/mcp", { preHandler: authGuard }, async (req, reply) => {
    const parsed = mcpServersSchema.safeParse((req.body ?? {}) as { servers?: unknown });
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid body", details: parsed.error.flatten() });
    }
    // Preserve existing secrets when the client round-trips masked values.
    const merged = mergeMaskedSecrets(parsed.data.servers, loadMcpServers());
    saveMcpServers(merged);
    // Hot reload: reconnect MCP clients and refresh every cached agent's tools.
    await reloadSharedTools();
    recordAudit({ actor: "admin", action: "mcp.save", detail: Object.keys(parsed.data.servers).join(",") });
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

/** Strip one layer of surrounding double quotes (users sometimes copy `KEY="value"` style). */
function stripQuotes(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

function ensureAdmin(): void {
  const cfg = loadConfig();
  const envPassword = stripQuotes(process.env.ICLAW_ADMIN_PASSWORD?.trim() ?? "");
  const existing = getAdminByUsername(cfg.adminUser);

  if (existing) {
    // ICLAW_ADMIN_PASSWORD is authoritative: keep the stored hash in sync,
    // so editing .env always takes effect after a restart.
    if (envPassword && !verifyPassword(envPassword, existing.passwordHash)) {
      setAdminPassword(cfg.adminUser, hashPassword(envPassword));
      logger.warn("管理员密码已按 ICLAW_ADMIN_PASSWORD 更新。");
    }
    return;
  }

  const password = envPassword || generateAdminPassword();
  createAdmin(cfg.adminUser, hashPassword(password));
  logger.warn(`已创建管理员账号：${cfg.adminUser}`);
  logger.warn(`管理员密码：${password}（请立即登录并妥善保管；可用环境变量 ICLAW_ADMIN_PASSWORD 覆盖）`);
}

export async function startServer(): Promise<void> {
  await initSharedTools();
  ensureAdmin();
  // Best-effort one-off consolidation at startup; a scheduler (T2.1) will run
  // this periodically later. Never let it block or crash boot.
  try {
    consolidateAllUsers();
  } catch (err) {
    logger.warn(`memory: startup consolidation failed: ${String(err)}`);
  }

  // Best-effort data retention purge on startup (no-op unless configured).
  try {
    const purge = purgeOldData(loadConfig().dataRetentionDays);
    if (purge.sessions + purge.audit + purge.usage > 0) {
      logger.info(`data: purged old rows sessions=${purge.sessions} audit=${purge.audit} usage=${purge.usage}`);
    }
  } catch (err) {
    logger.warn(`data: startup retention purge failed: ${String(err)}`);
  }

  // Start the periodic scheduler that delivers reminders/tasks to users.
  if (loadConfig().schedulerEnabled) {
    startScheduler({
      intervalMs: loadConfig().schedulerIntervalMs,
      handler: async (task) => {
        await runScheduledTask(task);
      },
      afterTasks: async () => {
        await runWatchers(async (watcher, detail) => {
          await handleWatcherChange(watcher, detail);
        });
      },
    });
    logger.info(`定时任务调度器已启动（间隔 ${loadConfig().schedulerIntervalMs}ms）`);
  }
  const app = buildApp(createBotHandler());
  const { host, port } = loadConfig().server;
  await app.listen({ host, port });
  logger.info(`管理端已启动：http://${host}:${port}`);

  // Start channels for already-bound bot accounts; new binds start their own.
  startChannelsForBoundAccounts(createBotHandler());

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopScheduler();
    stopAllChannels();
    void (async () => {
      const drained = await waitForIdle(5000);
      if (!drained) logger.warn("关闭超时：仍有在途对话未完成。");
      await app.close();
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
