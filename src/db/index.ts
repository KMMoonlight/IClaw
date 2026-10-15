import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";

import { resolveStateDir } from "../config.js";

let db: DatabaseSync | null = null;

export type UserStatus = "active" | "frozen";

export interface User {
  id: string;
  name: string;
  persona: string;
  memory: string;
  status: UserStatus;
  /** Tool names disabled for this user (empty = all allowed). */
  disabledTools: string[];
  /** Per-user model id override (empty = use the global model). */
  model: string;
  /** Skill names disabled for this user. */
  disabledSkills: string[];
  /** Currently-active session id (empty = none yet). */
  activeSession: string;
  createdAt: number;
}

export interface BotBinding {
  /** iLink bot 账号 id（归一化后的 ilink_bot_id）。 */
  accountId: string;
  /** 绑定到的用户。 */
  userId: string;
  /** 扫码者本人的微信 id（ilink_user_id）。 */
  wechatUserId: string;
  createdAt: number;
}

export interface Admin {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  createdAt: number;
}

export type AdminRole = "viewer" | "admin" | "owner";

const ROLE_RANK: Record<string, number> = { viewer: 0, admin: 1, owner: 2 };

/** Whether `role` is at least `min` in the viewer < admin < owner hierarchy. */
export function roleAtLeast(role: string, min: AdminRole): boolean {
  return (ROLE_RANK[role] ?? 0) >= ROLE_RANK[min]!;
}

/** 记忆分类：事实 / 偏好 / 事件 / 资料。 */
export type MemoryKind = "fact" | "preference" | "event" | "profile";

/** 记忆来源：用户显式要求 / 自动抽取 / 管理员编辑 / 旧字段迁移。 */
export type MemorySource = "user" | "auto" | "admin" | "legacy";

export interface Memory {
  id: string;
  userId: string;
  kind: string;
  content: string;
  source: string;
  importance: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  /** embedding 是否已写入（T1.3 向量检索用）。 */
  hasEmbedding: boolean;
}

export interface AddMemoryOptions {
  kind?: string;
  source?: string;
  importance?: number;
  embedding?: Float32Array;
}

export interface UpdateMemoryPatch {
  content?: string;
  kind?: string;
  importance?: number;
  embedding?: Float32Array | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT '',
  memory TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  tools_json TEXT NOT NULL DEFAULT '',
  disabled_skills TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  active_session TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_bindings (
  account_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  wechat_user_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_bindings_user ON bot_bindings (user_id);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  messages_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  importance REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories (user_id, created_at);
CREATE TABLE IF NOT EXISTS skill_settings (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  version TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  spec TEXT NOT NULL,
  prompt TEXT NOT NULL,
  payload TEXT,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks (status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user ON scheduled_tasks (user_id);
CREATE TABLE IF NOT EXISTS watchers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  spec TEXT NOT NULL,
  prompt TEXT NOT NULL,
  state TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  interval_ms INTEGER NOT NULL,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watchers_user ON watchers (user_id);
CREATE INDEX IF NOT EXISTS idx_watchers_due ON watchers (status, last_checked_at);
CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_total REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id);
`;

export function openDb(): DatabaseSync {
  if (db) return db;
  const dir = resolveStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "iclaw.db");
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  ensureColumn("users", "tools_json", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("users", "disabled_skills", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("users", "model", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("users", "active_session", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("admins", "role", "TEXT NOT NULL DEFAULT 'owner'");
  migrateSessionsV2();
  migrateLegacyMemory();
  return db;
}

/** Add a column to an existing table when missing (lightweight migration). */
function ensureColumn(table: string, column: string, ddl: string): void {
  const rows = openDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (rows.some((r) => r.name === column)) return;
  openDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/** For tests only. */
export function openDbInMemory(): DatabaseSync {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  migrateLegacyMemory();
  return db;
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

/** Parse a JSON array of strings, tolerating malformed input. */
function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function rowToUser(r: Record<string, unknown>): User {
  return {
    id: r.id as string,
    name: r.name as string,
    persona: (r.persona as string) ?? "",
    memory: (r.memory as string) ?? "",
    status: (r.status as string) as UserStatus,
    disabledTools: parseStringArray(r.tools_json),
    disabledSkills: parseStringArray(r.disabled_skills),
    model: (r.model as string) ?? "",
    activeSession: (r.active_session as string) ?? "",
    createdAt: r.created_at as number,
  };
}

export function createUser(name: string, persona = ""): User {
  const d = openDb();
  const user: User = { id: randomUUID(), name, persona, memory: "", status: "active", disabledTools: [], disabledSkills: [], model: "", activeSession: "", createdAt: Date.now() };
  d.prepare("INSERT INTO users (id, name, persona, memory, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    user.id,
    user.name,
    user.persona,
    user.memory,
    user.status,
    user.createdAt,
  );
  return user;
}

export function getUser(id: string): User | null {
  const r = openDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToUser(r) : null;
}

export function listUsers(): User[] {
  const rows = openDb().prepare("SELECT * FROM users ORDER BY created_at").all() as Record<string, unknown>[];
  return rows.map(rowToUser);
}

export function setUserStatus(id: string, status: UserStatus): void {
  openDb().prepare("UPDATE users SET status = ? WHERE id = ?").run(status, id);
}

export function setUserPersona(id: string, persona: string): void {
  openDb().prepare("UPDATE users SET persona = ? WHERE id = ?").run(persona, id);
}

export function setUserMemory(id: string, memory: string): void {
  openDb().prepare("UPDATE users SET memory = ? WHERE id = ?").run(memory, id);
}

export function appendUserMemory(id: string, fact: string): void {
  const user = getUser(id);
  if (!user) return;
  const sep = user.memory.trim() ? "\n" : "";
  setUserMemory(id, user.memory + sep + `- ${fact}`);
}

/** Overwrite the set of tool names disabled for a user. */
export function setUserDisabledTools(id: string, tools: string[]): void {
  openDb().prepare("UPDATE users SET tools_json = ? WHERE id = ?").run(JSON.stringify(tools), id);
}

/** Tool names disabled for a user (empty when unknown). */
export function getUserDisabledTools(id: string): string[] {
  return getUser(id)?.disabledTools ?? [];
}

/** Set (or clear) a user's model override. */
export function setUserModel(id: string, model: string): void {
  openDb().prepare("UPDATE users SET model = ? WHERE id = ?").run(model, id);
}

/** Skill names disabled for a user. */
export function getUserDisabledSkills(id: string): string[] {
  return getUser(id)?.disabledSkills ?? [];
}

export function setUserDisabledSkills(id: string, skills: string[]): void {
  openDb().prepare("UPDATE users SET disabled_skills = ? WHERE id = ?").run(JSON.stringify(skills), id);
}

// ---------------------------------------------------------------------------
// skill settings (global enable/version)
// ---------------------------------------------------------------------------

export interface SkillSetting {
  name: string;
  enabled: boolean;
  version: string | null;
}

export function listSkillSettings(): SkillSetting[] {
  const rows = openDb().prepare("SELECT name, enabled, version FROM skill_settings").all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    name: r.name as string,
    enabled: Number(r.enabled) !== 0,
    version: (r.version as string | null) ?? null,
  }));
}

/** Whether a skill is enabled globally (defaults to true when unset). */
export function isSkillEnabledGlobally(name: string): boolean {
  const r = openDb().prepare("SELECT enabled FROM skill_settings WHERE name = ?").get(name) as
    | { enabled: number }
    | undefined;
  return r ? Number(r.enabled) !== 0 : true;
}

export function setSkillEnabled(name: string, enabled: boolean, version?: string | null): void {
  openDb()
    .prepare(
      `INSERT INTO skill_settings (name, enabled, version, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled,
         version = COALESCE(excluded.version, skill_settings.version),
         updated_at = excluded.updated_at`,
    )
    .run(name, enabled ? 1 : 0, version ?? null, Date.now());
}

/** The set of skill names disabled for a user (globally disabled ∪ per-user). */
export function disabledSkillNamesForUser(userId: string): string[] {
  const global = listSkillSettings()
    .filter((s) => !s.enabled)
    .map((s) => s.name);
  return [...new Set([...global, ...getUserDisabledSkills(userId)])];
}

// ---------------------------------------------------------------------------
// bot bindings（扫码即绑定：一个 iLink bot 账号 ↔ 一个用户）
// ---------------------------------------------------------------------------

function rowToBinding(r: Record<string, unknown>): BotBinding {
  return {
    accountId: r.account_id as string,
    userId: r.user_id as string,
    wechatUserId: (r.wechat_user_id as string) ?? "",
    createdAt: r.created_at as number,
  };
}

export function bindBotAccount(accountId: string, userId: string, wechatUserId: string): void {
  openDb()
    .prepare("INSERT OR REPLACE INTO bot_bindings (account_id, user_id, wechat_user_id, created_at) VALUES (?, ?, ?, ?)")
    .run(accountId, userId, wechatUserId, Date.now());
}

export function getBindingByAccount(accountId: string): BotBinding | null {
  const r = openDb().prepare("SELECT * FROM bot_bindings WHERE account_id = ?").get(accountId) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToBinding(r) : null;
}

export function getBindingByUser(userId: string): BotBinding | null {
  const r = openDb().prepare("SELECT * FROM bot_bindings WHERE user_id = ?").get(userId) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToBinding(r) : null;
}

export function unbindBotAccount(accountId: string): void {
  openDb().prepare("DELETE FROM bot_bindings WHERE account_id = ?").run(accountId);
}

export function listBotBindings(): BotBinding[] {
  const rows = openDb().prepare("SELECT * FROM bot_bindings ORDER BY created_at").all() as Record<string, unknown>[];
  return rows.map(rowToBinding);
}

// ---------------------------------------------------------------------------
// sessions (multi-session transcript persistence)
// ---------------------------------------------------------------------------

export interface SessionInfo {
  id: string;
  userId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

const SESSIONS_V2_MIGRATED = "sessions_v2_migrated";

/** One-time migration of the legacy single-session-per-user table to multi-session. */
export function migrateSessionsV2(): void {
  if (getMeta(SESSIONS_V2_MIGRATED)) return;
  const db = openDb();
  const cols = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  // Fresh DBs already have the new shape (or no table yet).
  if (cols.length === 0 || cols.some((c) => c.name === "id")) {
    setMeta(SESSIONS_V2_MIGRATED, "1");
    return;
  }
  db.exec("ALTER TABLE sessions RENAME TO sessions_legacy");
  db.exec(
    `CREATE TABLE sessions (
       id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       title TEXT NOT NULL DEFAULT '',
       messages_json TEXT NOT NULL DEFAULT '[]',
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);`,
  );
  const rows = db.prepare("SELECT user_id, messages_json, updated_at FROM sessions_legacy").all() as {
    user_id: string;
    messages_json: string;
    updated_at: number;
  }[];
  for (const row of rows) {
    const id = randomUUID();
    const ts = row.updated_at ?? Date.now();
    db.prepare(
      "INSERT INTO sessions (id, user_id, title, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, row.user_id, "", row.messages_json ?? "[]", ts, ts);
    db.prepare("UPDATE users SET active_session = ? WHERE id = ?").run(id, row.user_id);
  }
  db.exec("DROP TABLE sessions_legacy");
  setMeta(SESSIONS_V2_MIGRATED, "1");
}

function rowToSession(r: Record<string, unknown>): SessionInfo {
  let messageCount = 0;
  try {
    const parsed = JSON.parse((r.messages_json as string) ?? "[]") as unknown;
    if (Array.isArray(parsed)) messageCount = parsed.length;
  } catch {
    messageCount = 0;
  }
  return {
    id: r.id as string,
    userId: r.user_id as string,
    title: (r.title as string) ?? "",
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    messageCount,
  };
}

/** Create a new session and make it active. Returns its id. */
export function createSession(userId: string, title = ""): string {
  const id = randomUUID();
  const now = Date.now();
  openDb()
    .prepare("INSERT INTO sessions (id, user_id, title, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, userId, title, "[]", now, now);
  openDb().prepare("UPDATE users SET active_session = ? WHERE id = ?").run(id, userId);
  return id;
}

/** Ensure the user has a valid active session; create one when missing. */
export function ensureActiveSession(userId: string): string {
  const user = getUser(userId);
  if (user?.activeSession) {
    const exists = openDb().prepare("SELECT id FROM sessions WHERE id = ?").get(user.activeSession) as
      | { id: string }
      | undefined;
    if (exists) return user.activeSession;
  }
  // No active session (or no user row): reuse the most recent session if any.
  const latest = openDb()
    .prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1")
    .get(userId) as { id: string } | undefined;
  if (latest) {
    openDb().prepare("UPDATE users SET active_session = ? WHERE id = ?").run(latest.id, userId);
    return latest.id;
  }
  return createSession(userId);
}

export function getActiveSessionId(userId: string): string | null {
  return getUser(userId)?.activeSession || null;
}

export function listSessions(userId: string): SessionInfo[] {
  const rows = openDb()
    .prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC")
    .all(userId) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function getSession(id: string): SessionInfo | null {
  const r = openDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToSession(r) : null;
}

/** A session plus its full transcript (for history/replay). */
export function getSessionDetail(id: string): (SessionInfo & { messages: unknown[] }) | null {
  const r = openDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  let messages: unknown[] = [];
  try {
    const parsed = JSON.parse((r.messages_json as string) ?? "[]") as unknown;
    if (Array.isArray(parsed)) messages = parsed;
  } catch {
    messages = [];
  }
  return { ...rowToSession(r), messages };
}

/** Switch the active session (must belong to the user). */
export function switchActiveSession(userId: string, sessionId: string): boolean {
  const session = getSession(sessionId);
  if (!session || session.userId !== userId) return false;
  openDb().prepare("UPDATE users SET active_session = ? WHERE id = ?").run(sessionId, userId);
  return true;
}

export function deleteSession(id: string): boolean {
  const res = openDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

/** Load the active session's transcript JSON. */
export function loadMessagesJson(userId: string): string {
  const id = ensureActiveSession(userId);
  const r = openDb().prepare("SELECT messages_json FROM sessions WHERE id = ?").get(id) as
    | { messages_json: string }
    | undefined;
  return r?.messages_json ?? "[]";
}

/** Persist the active session's transcript JSON. */
export function saveMessagesJson(userId: string, messagesJson: string): void {
  const id = ensureActiveSession(userId);
  openDb().prepare("UPDATE sessions SET messages_json = ?, updated_at = ? WHERE id = ?").run(messagesJson, Date.now(), id);
}

/** Start a fresh session for the user (previous sessions are kept). */
export function clearUserSession(userId: string): void {
  createSession(userId);
}

// ---------------------------------------------------------------------------
// usage (per-user, per-day token + cost accounting)
// ---------------------------------------------------------------------------

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costTotal: number;
}

export interface UsageTotal extends TokenUsage {
  userId: string;
}

/** Local (not UTC) YYYY-MM-DD day key. */
export function localDay(ts: number = Date.now()): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Add a turn's token/cost usage to a user's daily bucket. */
export function recordUsage(userId: string, usage: TokenUsage, day: string = localDay()): void {
  openDb()
    .prepare(
      `INSERT INTO usage (user_id, day, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_total, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         cost_total = cost_total + excluded.cost_total,
         updated_at = excluded.updated_at`,
    )
    .run(
      userId,
      day,
      Math.max(0, Math.round(usage.input)),
      Math.max(0, Math.round(usage.output)),
      Math.max(0, Math.round(usage.cacheRead)),
      Math.max(0, Math.round(usage.cacheWrite)),
      usage.costTotal,
      Date.now(),
    );
}

/** Total usage for one user across all days. */
export function getUserUsageTotal(userId: string): UsageTotal {
  const r = openDb()
    .prepare(
      `SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cache_read_tokens),0) AS cacheRead, COALESCE(SUM(cache_write_tokens),0) AS cacheWrite,
              COALESCE(SUM(cost_total),0) AS costTotal
       FROM usage WHERE user_id = ?`,
    )
    .get(userId) as Record<string, number>;
  return {
    userId,
    input: r.input ?? 0,
    output: r.output ?? 0,
    cacheRead: r.cacheRead ?? 0,
    cacheWrite: r.cacheWrite ?? 0,
    costTotal: r.costTotal ?? 0,
  };
}

/** Usage totals for every user with recorded usage. */
export function listUsageTotals(): UsageTotal[] {
  const rows = openDb()
    .prepare(
      `SELECT user_id AS userId,
              COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cache_read_tokens),0) AS cacheRead, COALESCE(SUM(cache_write_tokens),0) AS cacheWrite,
              COALESCE(SUM(cost_total),0) AS costTotal
       FROM usage GROUP BY user_id`,
    )
    .all() as Array<Record<string, number | string>>;
  return rows.map((r) => ({
    userId: r.userId as string,
    input: (r.input as number) ?? 0,
    output: (r.output as number) ?? 0,
    cacheRead: (r.cacheRead as number) ?? 0,
    cacheWrite: (r.cacheWrite as number) ?? 0,
    costTotal: (r.costTotal as number) ?? 0,
  }));
}

/** A user's usage for one day (zeroed when absent). */
export function getUserUsageForDay(userId: string, day: string = localDay()): TokenUsage {
  const r = openDb()
    .prepare(
      "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_total FROM usage WHERE user_id = ? AND day = ?",
    )
    .get(userId, day) as Record<string, number> | undefined;
  return {
    input: r?.input_tokens ?? 0,
    output: r?.output_tokens ?? 0,
    cacheRead: r?.cache_read_tokens ?? 0,
    cacheWrite: r?.cache_write_tokens ?? 0,
    costTotal: r?.cost_total ?? 0,
  };
}

// ---------------------------------------------------------------------------
// audit log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  userId: string | null;
  actor: string;
  action: string;
  detail: string;
  createdAt: number;
}

export interface RecordAuditInput {
  userId?: string | null;
  actor: string;
  action: string;
  detail?: string;
}

export function recordAudit(input: RecordAuditInput): void {
  openDb()
    .prepare("INSERT INTO audit_log (id, user_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), input.userId ?? null, input.actor, input.action, input.detail ?? "", Date.now());
}

function rowToAudit(r: Record<string, unknown>): AuditEntry {
  return {
    id: r.id as string,
    userId: (r.user_id as string | null) ?? null,
    actor: r.actor as string,
    action: r.action as string,
    detail: (r.detail as string) ?? "",
    createdAt: r.created_at as number,
  };
}

/** Most recent audit entries first. */
export function listAudit(options: { limit?: number; userId?: string } = {}): AuditEntry[] {
  const limit = Math.min(1000, Math.max(1, options.limit ?? 100));
  const rows = (
    options.userId
      ? openDb().prepare("SELECT * FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").all(options.userId, limit)
      : openDb().prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?").all(limit)
  ) as Record<string, unknown>[];
  return rows.map(rowToAudit);
}

// ---------------------------------------------------------------------------
// data lifecycle (export / delete / retention)
// ---------------------------------------------------------------------------

export interface UserDataExport {
  user: User | null;
  binding: BotBinding | null;
  memories: Memory[];
  sessions: Array<{ id: string; title: string; createdAt: number; updatedAt: number; messages: unknown[] }>;
  usage: UsageTotal;
  audit: AuditEntry[];
}

/** Full export of everything stored for a user (GDPR-style access). */
export function exportUserData(userId: string): UserDataExport {
  const sessions = (
    openDb().prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at ASC").all(userId) as Record<
      string,
      unknown
    >[]
  ).map((r) => {
    let messages: unknown[] = [];
    try {
      const parsed = JSON.parse((r.messages_json as string) ?? "[]") as unknown;
      if (Array.isArray(parsed)) messages = parsed;
    } catch {
      messages = [];
    }
    return {
      id: r.id as string,
      title: (r.title as string) ?? "",
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      messages,
    };
  });
  return {
    user: getUser(userId),
    binding: getBindingByUser(userId),
    memories: listMemories(userId),
    sessions,
    usage: getUserUsageTotal(userId),
    audit: listAudit({ userId, limit: 1000 }),
  };
}

export interface DeleteUserDataResult {
  sessions: number;
  memories: number;
  usage: number;
  audit: number;
  bindings: number;
  user: number;
}

/** Delete every row belonging to a user (right to erasure). */
export function deleteUserData(userId: string): DeleteUserDataResult {
  const db = openDb();
  const run = (sql: string): number => Number(db.prepare(sql).run(userId).changes);
  return {
    sessions: run("DELETE FROM sessions WHERE user_id = ?"),
    memories: run("DELETE FROM memories WHERE user_id = ?"),
    usage: run("DELETE FROM usage WHERE user_id = ?"),
    audit: run("DELETE FROM audit_log WHERE user_id = ?"),
    bindings: run("DELETE FROM bot_bindings WHERE user_id = ?"),
    user: run("DELETE FROM users WHERE id = ?"),
  };
}

export interface PurgeResult {
  sessions: number;
  audit: number;
  usage: number;
}

/** Purge rows older than `retentionDays`. No-op when retentionDays <= 0. */
export function purgeOldData(retentionDays: number, now = Date.now()): PurgeResult {
  if (retentionDays <= 0) return { sessions: 0, audit: 0, usage: 0 };
  const db = openDb();
  const cutoff = now - retentionDays * 86_400_000;
  const cutoffDay = localDay(cutoff);
  return {
    sessions: Number(db.prepare("DELETE FROM sessions WHERE updated_at < ?").run(cutoff).changes),
    audit: Number(db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoff).changes),
    usage: Number(db.prepare("DELETE FROM usage WHERE day < ?").run(cutoffDay).changes),
  };
}

// ---------------------------------------------------------------------------
// invites (self-service onboarding)
// ---------------------------------------------------------------------------

export interface Invite {
  code: string;
  note: string;
  createdAt: number;
  usedBy: string | null;
  usedAt: number | null;
}

function rowToInvite(r: Record<string, unknown>): Invite {
  return {
    code: r.code as string,
    note: (r.note as string) ?? "",
    createdAt: r.created_at as number,
    usedBy: (r.used_by as string | null) ?? null,
    usedAt: (r.used_at as number | null) ?? null,
  };
}

/** Create a single-use invite code for self-service onboarding. */
export function createInvite(note = ""): Invite {
  const invite: Invite = {
    code: randomBytes(9).toString("base64url"),
    note,
    createdAt: Date.now(),
    usedBy: null,
    usedAt: null,
  };
  openDb()
    .prepare("INSERT INTO invites (code, note, created_at, used_by, used_at) VALUES (?, ?, ?, ?, ?)")
    .run(invite.code, invite.note, invite.createdAt, invite.usedBy, invite.usedAt);
  return invite;
}

export function getInvite(code: string): Invite | null {
  const r = openDb().prepare("SELECT * FROM invites WHERE code = ?").get(code) as Record<string, unknown> | undefined;
  return r ? rowToInvite(r) : null;
}

export function listInvites(): Invite[] {
  const rows = openDb().prepare("SELECT * FROM invites ORDER BY created_at DESC").all() as Record<string, unknown>[];
  return rows.map(rowToInvite);
}

/**
 * Atomically claim a single-use invite. Returns false when the code is unknown
 * or was already claimed (so concurrent redeems cannot both win).
 */
export function markInviteUsed(code: string, userId: string): boolean {
  const res = openDb()
    .prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL")
    .run(userId, Date.now(), code);
  return Number(res.changes) > 0;
}

// ---------------------------------------------------------------------------
// admins
// ---------------------------------------------------------------------------

export function getAdminByUsername(username: string): Admin | null {
  const r = openDb().prepare("SELECT * FROM admins WHERE username = ?").get(username) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    username: r.username as string,
    passwordHash: r.password_hash as string,
    role: (r.role as string) ?? "owner",
    createdAt: r.created_at as number,
  };
}

export function listAdmins(): Admin[] {
  const rows = openDb().prepare("SELECT * FROM admins ORDER BY created_at").all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    username: r.username as string,
    passwordHash: r.password_hash as string,
    role: (r.role as string) ?? "owner",
    createdAt: r.created_at as number,
  }));
}

/** The role of an admin (defaults to the safest level when unknown). */
export function getAdminRole(username: string): AdminRole {
  const admin = getAdminByUsername(username);
  const role = admin?.role ?? "viewer";
  return role === "owner" || role === "admin" || role === "viewer" ? role : "viewer";
}

export function setAdminRole(username: string, role: AdminRole): void {
  openDb().prepare("UPDATE admins SET role = ? WHERE username = ?").run(role, username);
}

export function createAdmin(username: string, passwordHash: string, role: AdminRole = "owner"): Admin {
  const d = openDb();
  const admin: Admin = { id: randomUUID(), username, passwordHash, role, createdAt: Date.now() };
  d.prepare("INSERT INTO admins (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)").run(
    admin.id,
    admin.username,
    admin.passwordHash,
    admin.role,
    admin.createdAt,
  );
  return admin;
}

export function setAdminPassword(username: string, passwordHash: string): void {
  openDb().prepare("UPDATE admins SET password_hash = ? WHERE username = ?").run(passwordHash, username);
}

export function countAdmins(): number {
  const r = openDb().prepare("SELECT COUNT(*) AS n FROM admins").get() as { n: number };
  return r.n;
}

// ---------------------------------------------------------------------------
// meta (一次性迁移标记等)
// ---------------------------------------------------------------------------

export function getMeta(key: string): string | null {
  const r = openDb().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  openDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

// ---------------------------------------------------------------------------
// memories（结构化长期记忆；取代 users.memory 单字符串）
// ---------------------------------------------------------------------------

const LEGACY_MEMORY_MIGRATED = "legacy_memory_migrated_v1";

function rowToMemory(r: Record<string, unknown>): Memory {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    kind: (r.kind as string) ?? "fact",
    content: (r.content as string) ?? "",
    source: (r.source as string) ?? "user",
    importance: (r.importance as number) ?? 0.5,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    lastUsedAt: (r.last_used_at as number | null) ?? null,
    hasEmbedding: r.embedding != null,
  };
}

function embeddingToBlob(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function blobToEmbedding(blob: unknown): Float32Array | null {
  if (blob == null) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob as ArrayLike<number>);
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
  // Copy into an aligned buffer before reinterpreting as Float32Array.
  const aligned = new Uint8Array(buf.byteLength);
  aligned.set(buf);
  return new Float32Array(aligned.buffer, 0, aligned.byteLength / 4);
}

/** Persist a new memory for a user. Returns the stored row. */
export function addMemory(userId: string, content: string, opts: AddMemoryOptions = {}): Memory {
  const now = Date.now();
  const memory: Memory = {
    id: randomUUID(),
    userId,
    kind: opts.kind ?? "fact",
    content,
    source: opts.source ?? "user",
    importance: opts.importance ?? 0.5,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    hasEmbedding: opts.embedding != null,
  };
  openDb()
    .prepare(
      "INSERT INTO memories (id, user_id, kind, content, source, importance, created_at, updated_at, last_used_at, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      memory.id,
      memory.userId,
      memory.kind,
      memory.content,
      memory.source,
      memory.importance,
      memory.createdAt,
      memory.updatedAt,
      memory.lastUsedAt,
      opts.embedding ? embeddingToBlob(opts.embedding) : null,
    );
  return memory;
}

/** List a user's memories, oldest first. */
export function listMemories(userId: string): Memory[] {
  const rows = openDb()
    .prepare("SELECT * FROM memories WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId) as Record<string, unknown>[];
  return rows.map(rowToMemory);
}

export function getMemory(id: string): Memory | null {
  const r = openDb().prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? rowToMemory(r) : null;
}

/** Case-insensitive exact-content lookup, used for de-duplication. */
export function findMemoryByContent(userId: string, content: string): Memory | null {
  const r = openDb()
    .prepare("SELECT * FROM memories WHERE user_id = ? AND lower(content) = lower(?) LIMIT 1")
    .get(userId, content) as Record<string, unknown> | undefined;
  return r ? rowToMemory(r) : null;
}

export function updateMemory(id: string, patch: UpdateMemoryPatch): Memory | null {
  const existing = getMemory(id);
  if (!existing) return null;
  const content = patch.content ?? existing.content;
  const kind = patch.kind ?? existing.kind;
  const importance = patch.importance ?? existing.importance;
  const now = Date.now();
  if (patch.embedding === undefined) {
    openDb()
      .prepare("UPDATE memories SET content = ?, kind = ?, importance = ?, updated_at = ? WHERE id = ?")
      .run(content, kind, importance, now, id);
  } else {
    openDb()
      .prepare("UPDATE memories SET content = ?, kind = ?, importance = ?, updated_at = ?, embedding = ? WHERE id = ?")
      .run(content, kind, importance, now, patch.embedding ? embeddingToBlob(patch.embedding) : null, id);
  }
  return getMemory(id);
}

export function deleteMemory(id: string): boolean {
  const res = openDb().prepare("DELETE FROM memories WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

/** Delete all memories for a user; returns how many rows were removed. */
export function clearUserMemories(userId: string): number {
  const res = openDb().prepare("DELETE FROM memories WHERE user_id = ?").run(userId);
  return Number(res.changes);
}

export function countUserMemories(userId: string): number {
  const r = openDb().prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ?").get(userId) as { n: number };
  return r.n;
}

/** Store/replace an embedding vector for a memory. */
export function setMemoryEmbedding(id: string, embedding: Float32Array | null): void {
  openDb()
    .prepare("UPDATE memories SET embedding = ?, updated_at = ? WHERE id = ?")
    .run(embedding ? embeddingToBlob(embedding) : null, Date.now(), id);
}

export function getMemoryEmbedding(id: string): Float32Array | null {
  const r = openDb().prepare("SELECT embedding FROM memories WHERE id = ?").get(id) as
    | { embedding: unknown }
    | undefined;
  return r ? blobToEmbedding(r.embedding) : null;
}

/** Mark memories as just-used (recency signal for retrieval/decay). */
export function touchMemories(ids: string[]): void {
  if (ids.length === 0) return;
  const stmt = openDb().prepare("UPDATE memories SET last_used_at = ? WHERE id = ?");
  const now = Date.now();
  for (const id of ids) stmt.run(now, id);
}

/**
 * Split a legacy `users.memory` blob into individual facts.
 * Legacy format is one `- fact` per line; anything else is kept as a single entry.
 */
export function splitLegacyMemory(memory: string): string[] {
  const lines = memory
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const facts = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter(Boolean);
  if (facts.length > 0) return facts;
  return memory.trim() ? [memory.trim()] : [];
}

/**
 * One-time migration: fold each user's legacy `users.memory` string into the
 * structured `memories` table. Guarded by a meta flag so it never duplicates.
 */
export function migrateLegacyMemory(): void {
  if (getMeta(LEGACY_MEMORY_MIGRATED)) return;
  const rows = openDb().prepare("SELECT id, memory FROM users WHERE memory != ''").all() as {
    id: string;
    memory: string;
  }[];
  let migrated = 0;
  for (const row of rows) {
    for (const fact of splitLegacyMemory(row.memory)) {
      addMemory(row.id, fact, { kind: "fact", source: "legacy", importance: 0.5 });
      migrated += 1;
    }
  }
  setMeta(LEGACY_MEMORY_MIGRATED, String(migrated));
  if (migrated > 0) {
    // eslint-disable-next-line no-console
    console.info(`db: migrated ${migrated} legacy memory entr(ies) into memories table`);
  }
}
