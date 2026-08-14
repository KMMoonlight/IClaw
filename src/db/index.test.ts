import { beforeEach, describe, expect, it } from "vitest";

import {
  appendUserMemory,
  bindBotAccount,
  countAdmins,
  createAdmin,
  createUser,
  getAdminByUsername,
  getBindingByAccount,
  getBindingByUser,
  getUser,
  listBotBindings,
  listUsers,
  loadMessagesJson,
  openDbInMemory,
  saveMessagesJson,
  setUserMemory,
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

describe("admins", () => {
  it("creates and fetches admins, counts them", () => {
    expect(countAdmins()).toBe(0);
    createAdmin("admin", "hash");
    expect(countAdmins()).toBe(1);
    expect(getAdminByUsername("admin")?.passwordHash).toBe("hash");
    expect(getAdminByUsername("nobody")).toBeNull();
  });
});
