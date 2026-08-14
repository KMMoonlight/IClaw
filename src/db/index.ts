import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { resolveStateDir } from "../config.js";

let db: DatabaseSync | null = null;

export type UserStatus = "active" | "frozen";

export interface User {
  id: string;
  name: string;
  persona: string;
  memory: string;
  status: UserStatus;
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
  createdAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT '',
  memory TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
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
  user_id TEXT PRIMARY KEY,
  messages_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export function openDb(): DatabaseSync {
  if (db) return db;
  const dir = resolveStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "iclaw.db");
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

/** For tests only. */
export function openDbInMemory(): DatabaseSync {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

function rowToUser(r: Record<string, unknown>): User {
  return {
    id: r.id as string,
    name: r.name as string,
    persona: (r.persona as string) ?? "",
    memory: (r.memory as string) ?? "",
    status: (r.status as string) as UserStatus,
    createdAt: r.created_at as number,
  };
}

export function createUser(name: string, persona = ""): User {
  const d = openDb();
  const user: User = { id: randomUUID(), name, persona, memory: "", status: "active", createdAt: Date.now() };
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
// sessions (per-user transcript persistence)
// ---------------------------------------------------------------------------

export function loadMessagesJson(userId: string): string {
  const r = openDb().prepare("SELECT messages_json FROM sessions WHERE user_id = ?").get(userId) as
    | { messages_json: string }
    | undefined;
  return r?.messages_json ?? "[]";
}

export function saveMessagesJson(userId: string, messagesJson: string): void {
  openDb()
    .prepare("INSERT OR REPLACE INTO sessions (user_id, messages_json, updated_at) VALUES (?, ?, ?)")
    .run(userId, messagesJson, Date.now());
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
    createdAt: r.created_at as number,
  };
}

export function createAdmin(username: string, passwordHash: string): Admin {
  const d = openDb();
  const admin: Admin = { id: randomUUID(), username, passwordHash, createdAt: Date.now() };
  d.prepare("INSERT INTO admins (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)").run(
    admin.id,
    admin.username,
    admin.passwordHash,
    admin.createdAt,
  );
  return admin;
}

export function countAdmins(): number {
  const r = openDb().prepare("SELECT COUNT(*) AS n FROM admins").get() as { n: number };
  return r.n;
}
