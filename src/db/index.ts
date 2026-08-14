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

export interface Binding {
  wechatId: string;
  userId: string;
  accountId: string;
  createdAt: number;
}

export interface Invite {
  code: string;
  userId: string | null;
  status: "pending" | "used" | "revoked";
  createdAt: number;
  boundAt: number | null;
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
CREATE TABLE IF NOT EXISTS bindings (
  wechat_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  bound_at INTEGER
);
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
// bindings
// ---------------------------------------------------------------------------

export function getBindingByWechat(wechatId: string): Binding | null {
  const r = openDb().prepare("SELECT * FROM bindings WHERE wechat_id = ?").get(wechatId) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return {
    wechatId: r.wechat_id as string,
    userId: r.user_id as string,
    accountId: r.account_id as string,
    createdAt: r.created_at as number,
  };
}

export function bindWechat(wechatId: string, userId: string, accountId: string): void {
  openDb()
    .prepare("INSERT OR REPLACE INTO bindings (wechat_id, user_id, account_id, created_at) VALUES (?, ?, ?, ?)")
    .run(wechatId, userId, accountId, Date.now());
}

export function unbindWechat(wechatId: string): void {
  openDb().prepare("DELETE FROM bindings WHERE wechat_id = ?").run(wechatId);
}

export function listBindings(): Binding[] {
  const rows = openDb().prepare("SELECT * FROM bindings ORDER BY created_at").all() as Record<string, unknown>[];
  return rows.map((r) => ({
    wechatId: r.wechat_id as string,
    userId: r.user_id as string,
    accountId: r.account_id as string,
    createdAt: r.created_at as number,
  }));
}

// ---------------------------------------------------------------------------
// invites
// ---------------------------------------------------------------------------

export function createInvite(code: string, userId: string | null): Invite {
  const d = openDb();
  const invite: Invite = { code, userId, status: "pending", createdAt: Date.now(), boundAt: null };
  d.prepare("INSERT INTO invites (code, user_id, status, created_at, bound_at) VALUES (?, ?, ?, ?, ?)").run(
    invite.code,
    invite.userId,
    invite.status,
    invite.createdAt,
    invite.boundAt,
  );
  return invite;
}

export function getInvite(code: string): Invite | null {
  const r = openDb().prepare("SELECT * FROM invites WHERE code = ?").get(code) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    code: r.code as string,
    userId: (r.user_id as string) ?? null,
    status: r.status as Invite["status"],
    createdAt: r.created_at as number,
    boundAt: (r.bound_at as number) ?? null,
  };
}

export function markInviteUsed(code: string, userId: string): void {
  openDb().prepare("UPDATE invites SET status = 'used', user_id = ?, bound_at = ? WHERE code = ?").run(userId, Date.now(), code);
}

export function revokeInvite(code: string): void {
  openDb().prepare("UPDATE invites SET status = 'revoked' WHERE code = ?").run(code);
}

export function listInvites(): Invite[] {
  const rows = openDb().prepare("SELECT * FROM invites ORDER BY created_at").all() as Record<string, unknown>[];
  return rows.map((r) => ({
    code: r.code as string,
    userId: (r.user_id as string) ?? null,
    status: r.status as Invite["status"],
    createdAt: r.created_at as number,
    boundAt: (r.bound_at as number) ?? null,
  }));
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
