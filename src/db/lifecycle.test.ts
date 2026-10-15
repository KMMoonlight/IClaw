import { beforeEach, describe, expect, it } from "vitest";

import {
  addMemory,
  bindBotAccount,
  createSession,
  createUser,
  deleteUserData,
  exportUserData,
  getUser,
  loadMessagesJson,
  localDay,
  openDb,
  openDbInMemory,
  purgeOldData,
  recordAudit,
  recordUsage,
  saveMessagesJson,
} from "./index.js";

beforeEach(() => {
  openDbInMemory();
});

describe("exportUserData", () => {
  it("gathers everything stored for a user", () => {
    const u = createUser("u", "persona");
    bindBotAccount("acc-1", u.id, "wx-1");
    addMemory(u.id, "喜欢咖啡");
    saveMessagesJson(u.id, '[{"role":"user","content":[]},{"role":"assistant","content":[]}]');
    recordUsage(u.id, { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, costTotal: 0.01 });
    recordAudit({ actor: "agent", userId: u.id, action: "tool:bash", detail: "ok" });

    const dump = exportUserData(u.id);
    expect(dump.user?.id).toBe(u.id);
    expect(dump.binding?.accountId).toBe("acc-1");
    expect(dump.memories.map((m) => m.content)).toEqual(["喜欢咖啡"]);
    expect(dump.sessions).toHaveLength(1);
    expect(dump.sessions[0]!.messages).toHaveLength(2);
    expect(dump.usage.input).toBe(10);
    expect(dump.audit.some((a) => a.action === "tool:bash")).toBe(true);
  });
});

describe("deleteUserData", () => {
  it("removes every row for the user", () => {
    const u = createUser("u");
    bindBotAccount("acc-1", u.id, "wx-1");
    addMemory(u.id, "fact");
    saveMessagesJson(u.id, "[]");
    recordUsage(u.id, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costTotal: 0 });
    recordAudit({ actor: "admin", userId: u.id, action: "user.create" });

    const removed = deleteUserData(u.id);
    expect(removed.user).toBe(1);
    expect(removed.bindings).toBe(1);
    expect(removed.memories).toBe(1);
    expect(removed.sessions).toBe(1);
    expect(removed.usage).toBe(1);
    expect(removed.audit).toBe(1);
    expect(getUser(u.id)).toBeNull();
    expect(exportUserData(u.id).memories).toEqual([]);
  });
});

describe("purgeOldData", () => {
  function backdateSession(ageDays: number): void {
    const id = createSession("u");
    openDb()
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(Date.now() - ageDays * 86_400_000, id);
  }

  it("is a no-op when retention is disabled", () => {
    backdateSession(400);
    expect(purgeOldData(0)).toEqual({ sessions: 0, audit: 0, usage: 0 });
  });

  it("purges rows older than the retention window", () => {
    const db = openDb();
    backdateSession(400);
    const recent = createSession("u2");
    recordAudit({ actor: "admin", action: "old" });
    db.prepare("UPDATE audit_log SET created_at = ? WHERE action = 'old'").run(Date.now() - 400 * 86_400_000);
    recordUsage("u3", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 }, localDay(Date.now() - 400 * 86_400_000));
    recordUsage("u4", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 }, localDay());

    const purge = purgeOldData(90);
    expect(purge.sessions).toBe(1);
    expect(purge.audit).toBe(1);
    expect(purge.usage).toBe(1);
    // Recent rows survive.
    expect(openDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(recent)).toEqual({ n: 1 });
  });
});
