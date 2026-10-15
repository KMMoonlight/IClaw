import { beforeEach, describe, expect, it } from "vitest";

import {
  appendUserMemory,
  bindBotAccount,
  countAdmins,
  createAdmin,
  createInvite,
  createUser,
  getAdminByUsername,
  getAdminRole,
  getBindingByAccount,
  getBindingByUser,
  getUser,
  getUserDisabledSkills,
  getUserDisabledTools,
  getInvite,
  getUserUsageForDay,
  getUserUsageTotal,
  listBotBindings,
  listAdmins,
  listInvites,
  listSkillSettings,
  listUsageTotals,
  listUsers,
  listAudit,
  loadMessagesJson,
  localDay,
  markInviteUsed,
  isSkillEnabledGlobally,
  disabledSkillNamesForUser,
  openDbInMemory,
  recordAudit,
  recordUsage,
  roleAtLeast,
  saveMessagesJson,
  setAdminPassword,
  setAdminRole,
  setSkillEnabled,
  setUserDisabledSkills,
  setUserDisabledTools,
  setUserMemory,
  setUserModel,
  setUserPersona,
  setUserStatus,
  unbindBotAccount,
} from "./index.js";

beforeEach(() => {
  // Fresh in-memory DB per test (replaces the module-level handle).
  openDbInMemory();
});

describe("users", () => {
  it("creates, lists and fetches users", () => {
    const a = createUser("张三", "persona-a");
    const b = createUser("李四");
    expect(a.id).toBeTruthy();
    expect(a.status).toBe("active");
    expect(listUsers()).toHaveLength(2);
    expect(getUser(a.id)?.name).toBe("张三");
    expect(getUser(a.id)?.persona).toBe("persona-a");
    expect(getUser(b.id)?.persona).toBe("");
    expect(getUser("missing")).toBeNull();
  });

  it("updates persona, memory and status", () => {
    const u = createUser("u");
    setUserPersona(u.id, "p2");
    setUserMemory(u.id, "m2");
    setUserStatus(u.id, "frozen");
    const got = getUser(u.id)!;
    expect(got.persona).toBe("p2");
    expect(got.memory).toBe("m2");
    expect(got.status).toBe("frozen");
  });

  it("appends memory facts with separators", () => {
    const u = createUser("u");
    appendUserMemory(u.id, "fact 1");
    appendUserMemory(u.id, "fact 2");
    expect(getUser(u.id)?.memory).toBe("- fact 1\n- fact 2");
    appendUserMemory("missing", "fact");
    expect(getUser(u.id)?.memory).toBe("- fact 1\n- fact 2");
  });

  it("stores and reads the per-user disabled tool policy", () => {
    const u = createUser("u");
    expect(getUserDisabledTools(u.id)).toEqual([]);
    expect(getUser(u.id)?.disabledTools).toEqual([]);
    setUserDisabledTools(u.id, ["bash", "write_file"]);
    expect(getUserDisabledTools(u.id)).toEqual(["bash", "write_file"]);
    setUserDisabledTools(u.id, []);
    expect(getUserDisabledTools(u.id)).toEqual([]);
  });

  it("stores a per-user model override", () => {
    const u = createUser("u");
    expect(getUser(u.id)?.model).toBe("");
    setUserModel(u.id, "gpt-4o-mini");
    expect(getUser(u.id)?.model).toBe("gpt-4o-mini");
    setUserModel(u.id, "");
    expect(getUser(u.id)?.model).toBe("");
  });

  it("stores per-user disabled skills and global skill settings", () => {
    const u = createUser("u");
    expect(getUserDisabledSkills(u.id)).toEqual([]);
    setUserDisabledSkills(u.id, ["foo"]);
    expect(getUserDisabledSkills(u.id)).toEqual(["foo"]);
    expect(isSkillEnabledGlobally("foo")).toBe(true);
    setSkillEnabled("foo", false, "1.0.0");
    expect(isSkillEnabledGlobally("foo")).toBe(false);
    expect(listSkillSettings()).toEqual([{ name: "foo", enabled: false, version: "1.0.0" }]);
    expect(disabledSkillNamesForUser(u.id)).toContain("foo");
  });
});

describe("bot bindings", () => {
  it("binds a bot account to a user and looks it up both ways", () => {
    const u = createUser("u1");
    bindBotAccount("acc-1", u.id, "wx-user-1");
    expect(getBindingByAccount("acc-1")?.userId).toBe(u.id);
    expect(getBindingByUser(u.id)?.accountId).toBe("acc-1");
    expect(getBindingByUser(u.id)?.wechatUserId).toBe("wx-user-1");
    expect(getBindingByAccount("missing")).toBeNull();
    expect(listBotBindings()).toHaveLength(1);
  });

  it("replaces a binding for the same account and enforces one bot per user", () => {
    const u1 = createUser("u1");
    const u2 = createUser("u2");
    bindBotAccount("acc-1", u1.id, "wx-1");
    // Same account re-bound to another user: account id is the primary key.
    bindBotAccount("acc-1", u2.id, "wx-2");
    expect(getBindingByAccount("acc-1")?.userId).toBe(u2.id);
    expect(listBotBindings()).toHaveLength(1);
    // A second account for the same user is a separate row; the caller
    // (binding service) is responsible for replacing old ones.
    bindBotAccount("acc-2", u2.id, "wx-2");
    expect(listBotBindings()).toHaveLength(2);
  });

  it("unbinds an account", () => {
    const u = createUser("u1");
    bindBotAccount("acc-1", u.id, "wx-1");
    unbindBotAccount("acc-1");
    expect(getBindingByAccount("acc-1")).toBeNull();
    expect(getBindingByUser(u.id)).toBeNull();
    expect(listBotBindings()).toHaveLength(0);
  });
});

describe("sessions", () => {
  it("round-trips the transcript JSON", () => {
    expect(loadMessagesJson("u1")).toBe("[]");
    saveMessagesJson("u1", '[{"role":"user"}]');
    expect(loadMessagesJson("u1")).toBe('[{"role":"user"}]');
    saveMessagesJson("u1", '[{"role":"assistant"}]');
    expect(loadMessagesJson("u1")).toBe('[{"role":"assistant"}]');
  });
});

describe("audit log", () => {
  it("records and filters audit entries", () => {
    const u = createUser("u");
    recordAudit({ actor: "admin", action: "user.create", userId: u.id, detail: u.name });
    recordAudit({ actor: "agent", action: "tool:bash", userId: u.id, detail: "ok {}" });
    recordAudit({ actor: "admin", action: "mcp.save" });

    expect(listAudit().length).toBe(3);
    const forUser = listAudit({ userId: u.id });
    expect(forUser).toHaveLength(2);
    expect(forUser.map((e) => e.action).sort()).toEqual(["tool:bash", "user.create"]);
    expect(forUser[0]!.userId).toBe(u.id);
    expect(listAudit({ limit: 1 })).toHaveLength(1);
    expect(listAudit().find((e) => e.action === "mcp.save")!.userId).toBeNull();
  });
});

describe("invites", () => {
  it("creates, looks up, lists and marks used", () => {
    const a = createInvite("note-a");
    expect(a.code).toBeTruthy();
    expect(getInvite(a.code)?.note).toBe("note-a");
    expect(getInvite("nope")).toBeNull();
    const u = createUser("u");
    expect(markInviteUsed(a.code, u.id)).toBe(true);
    expect(getInvite(a.code)?.usedBy).toBe(u.id);
    // A second claim (concurrent redeem) must not overwrite the winner.
    const u2 = createUser("u2");
    expect(markInviteUsed(a.code, u2.id)).toBe(false);
    expect(getInvite(a.code)?.usedBy).toBe(u.id);
    createInvite();
    expect(listInvites()).toHaveLength(2);
  });
});

describe("admins", () => {
  it("creates and fetches admins, counts them", () => {
    expect(countAdmins()).toBe(0);
    createAdmin("admin", "hash");
    expect(countAdmins()).toBe(1);
    expect(getAdminByUsername("admin")?.passwordHash).toBe("hash");
    expect(getAdminByUsername("nobody")).toBeNull();
  });

  it("updates an admin password hash in place", () => {
    createAdmin("admin", "hash-old");
    setAdminPassword("admin", "hash-new");
    expect(getAdminByUsername("admin")?.passwordHash).toBe("hash-new");
    expect(countAdmins()).toBe(1);
  });

  it("supports admin roles with a viewer < admin < owner hierarchy", () => {
    createAdmin("owner1", "h", "owner");
    createAdmin("viewer1", "h", "viewer");
    expect(getAdminRole("owner1")).toBe("owner");
    expect(getAdminRole("viewer1")).toBe("viewer");
    expect(getAdminRole("missing")).toBe("viewer");
    setAdminRole("viewer1", "admin");
    expect(getAdminRole("viewer1")).toBe("admin");
    expect(listAdmins().map((a) => a.username).sort()).toEqual(["owner1", "viewer1"]);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("viewer", "admin")).toBe(false);
    expect(roleAtLeast("owner", "admin")).toBe(true);
  });
});

describe("usage", () => {
  it("formats local day keys", () => {
    expect(localDay(new Date(2024, 0, 2, 15).getTime())).toBe("2024-01-02");
  });

  it("accumulates per-user, per-day usage", () => {
    const u = createUser("u");
    const day = localDay(new Date(2024, 0, 2).getTime());
    recordUsage(u.id, { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, costTotal: 0.01 }, day);
    recordUsage(u.id, { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, costTotal: 0.02 }, day);
    const forDay = getUserUsageForDay(u.id, day);
    expect(forDay.input).toBe(30);
    expect(forDay.output).toBe(10);
    expect(forDay.cacheRead).toBe(1);
    expect(forDay.cacheWrite).toBe(2);
    expect(forDay.costTotal).toBeCloseTo(0.03, 6);

    recordUsage(u.id, { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 }, localDay(new Date(2024, 0, 3).getTime()));
    expect(getUserUsageTotal(u.id).input).toBe(37);
    expect(getUserUsageForDay(u.id, day).input).toBe(30);
    expect(getUserUsageForDay(u.id)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 });
  });

  it("lists totals per user", () => {
    const a = createUser("a");
    const b = createUser("b");
    recordUsage(a.id, { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 });
    recordUsage(b.id, { input: 4, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0 });
    const totals = listUsageTotals();
    expect(totals.map((t) => t.userId).sort()).toEqual([a.id, b.id].sort());
    expect(totals.find((t) => t.userId === a.id)!.input).toBe(3);
  });
});
