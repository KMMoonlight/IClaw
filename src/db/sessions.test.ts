import { beforeEach, describe, expect, it } from "vitest";

import {
  clearUserSession,
  createSession,
  createUser,
  deleteSession,
  ensureActiveSession,
  getActiveSessionId,
  getSession,
  listSessions,
  loadMessagesJson,
  migrateSessionsV2,
  openDb,
  openDbInMemory,
  saveMessagesJson,
  setMeta,
  switchActiveSession,
} from "./index.js";

beforeEach(() => {
  openDbInMemory();
});

describe("multi-session transcripts", () => {
  it("auto-creates an active session on first access", () => {
    const u = createUser("u");
    expect(getActiveSessionId(u.id)).toBeNull();
    expect(loadMessagesJson(u.id)).toBe("[]");
    const id = getActiveSessionId(u.id);
    expect(id).toBeTruthy();
    expect(getSession(id!)).not.toBeNull();
  });

  it("saves and reloads the active session's transcript", () => {
    const u = createUser("u");
    saveMessagesJson(u.id, '[{"role":"user","content":[]}]');
    expect(loadMessagesJson(u.id)).toBe('[{"role":"user","content":[]}]');
    expect(listSessions(u.id)[0]!.messageCount).toBe(1);
  });

  it("starts a fresh session while keeping history", () => {
    const u = createUser("u");
    saveMessagesJson(u.id, '[{"role":"user","content":[]}]');
    const first = getActiveSessionId(u.id)!;
    clearUserSession(u.id);
    const second = getActiveSessionId(u.id)!;
    expect(second).not.toBe(first);
    expect(loadMessagesJson(u.id)).toBe("[]");
    expect(listSessions(u.id)).toHaveLength(2);
    expect(getSession(first)!.messageCount).toBe(1);
  });

  it("switches the active session and rejects foreign ids", () => {
    const u = createUser("u");
    const other = createUser("other");
    const a = createSession(u.id, "first");
    saveMessagesJson(u.id, '[{"role":"user","content":[]}]'); // writes to a
    const b = createSession(u.id, "second");
    expect(getActiveSessionId(u.id)).toBe(b);

    expect(switchActiveSession(u.id, a)).toBe(true);
    expect(getActiveSessionId(u.id)).toBe(a);
    expect(loadMessagesJson(u.id)).toBe('[{"role":"user","content":[]}]');

    const foreign = createSession(other.id);
    expect(switchActiveSession(u.id, foreign)).toBe(false);
    expect(switchActiveSession(u.id, "missing")).toBe(false);
  });

  it("deletes sessions", () => {
    const u = createUser("u");
    const id = ensureActiveSession(u.id);
    expect(deleteSession(id)).toBe(true);
    expect(deleteSession(id)).toBe(false);
    expect(getSession(id)).toBeNull();
  });
});

describe("migrateSessionsV2", () => {
  it("upgrades a legacy single-session table", () => {
    const db = openDb();
    db.exec("DROP TABLE sessions");
    db.exec("DROP INDEX IF EXISTS idx_sessions_user");
    db.exec("CREATE TABLE sessions (user_id TEXT PRIMARY KEY, messages_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL)");
    const u = createUser("u");
    db.prepare("INSERT INTO sessions (user_id, messages_json, updated_at) VALUES (?, ?, ?)").run(
      u.id,
      '[{"role":"user","content":[]}]',
      111,
    );
    setMeta("sessions_v2_migrated", "");
    migrateSessionsV2();

    const sessions = listSessions(u.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messageCount).toBe(1);
    expect(getActiveSessionId(u.id)).toBe(sessions[0]!.id);
    expect(loadMessagesJson(u.id)).toBe('[{"role":"user","content":[]}]');
  });
});
