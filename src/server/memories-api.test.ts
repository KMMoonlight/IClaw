import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetConfigCache } from "../config.js";
import { openDbInMemory, createAdmin, createUser, listMemories, addMemory, saveMessagesJson, markInviteUsed } from "../db/index.js";
import { loadMcpServers } from "../agent/mcp.js";
import { inc } from "../metrics.js";
import { buildApp } from "./app.js";
import { signSession } from "./auth.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iclaw-mem-api-test-"));
const origStateDir = process.env.ICLAW_STATE_DIR;
const origMcp = process.env.ICLAW_MCP_CONFIG;

let app: ReturnType<typeof buildApp>;
let cookie: string;

beforeAll(async () => {
  process.env.ICLAW_STATE_DIR = stateDir;
  process.env.ICLAW_MCP_CONFIG = path.join(stateDir, "mcp.json");
  resetConfigCache();
  openDbInMemory();
  app = buildApp(async () => {});
  await app.ready();
  cookie = `iclaw_session=${signSession("admin")}`;
});

afterAll(async () => {
  await app.close();
  if (origStateDir === undefined) delete process.env.ICLAW_STATE_DIR;
  else process.env.ICLAW_STATE_DIR = origStateDir;
  if (origMcp === undefined) delete process.env.ICLAW_MCP_CONFIG;
  else process.env.ICLAW_MCP_CONFIG = origMcp;
  resetConfigCache();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  openDbInMemory();
  createAdmin("admin", "hash", "owner");
});

function inject(opts: { method?: string; url: string; payload?: unknown; withCookie?: boolean }) {
  const headers: Record<string, string> = {};
  if (opts.withCookie !== false) headers.cookie = cookie;
  if (opts.payload !== undefined) headers["content-type"] = "application/json";
  // Fastify's inject() overloads confuse TS here; tests only use a small shape.
  const res = (app as any).inject({ method: opts.method ?? "GET", url: opts.url, headers, payload: opts.payload });
  return res as Promise<{ statusCode: number; json: <T = unknown>() => T; body: string; headers: Record<string, string> }>;
}

describe("memory API", () => {
  it("requires authentication", async () => {
    const u = createUser("u");
    const res = await inject({ url: `/api/users/${u.id}/memories`, withCookie: false });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown user", async () => {
    const res = await inject({ url: "/api/users/missing/memories" });
    expect(res.statusCode).toBe(404);
  });

  it("creates and lists memories", async () => {
    const u = createUser("u");
    const created = await inject({
      method: "POST",
      url: `/api/users/${u.id}/memories`,
      payload: { content: "喜欢喝茶", kind: "preference", importance: 0.8 },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { id: string; source: string; kind: string };
    expect(body.source).toBe("admin");
    expect(body.kind).toBe("preference");

    const listed = await inject({ url: `/api/users/${u.id}/memories` });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json() as { content: string }[];
    expect(rows.map((r) => r.content)).toEqual(["喜欢喝茶"]);
  });

  it("validates the create body", async () => {
    const u = createUser("u");
    const res = await inject({ method: "POST", url: `/api/users/${u.id}/memories`, payload: { content: "" } });
    expect(res.statusCode).toBe(400);
    const res2 = await inject({
      method: "POST",
      url: `/api/users/${u.id}/memories`,
      payload: { content: "x", kind: "bogus" },
    });
    expect(res2.statusCode).toBe(400);
  });

  it("updates a memory", async () => {
    const u = createUser("u");
    const created = (await inject({ method: "POST", url: `/api/users/${u.id}/memories`, payload: { content: "old" } })).json() as {
      id: string;
    };
    const res = await inject({ method: "PATCH", url: `/api/memories/${created.id}`, payload: { content: "new" } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { content: string }).content).toBe("new");
    const missing = await inject({ method: "PATCH", url: "/api/memories/nope", payload: { content: "x" } });
    expect(missing.statusCode).toBe(404);
  });

  it("deletes a memory and clears all for a user", async () => {
    const u = createUser("u");
    const a = (await inject({ method: "POST", url: `/api/users/${u.id}/memories`, payload: { content: "a" } })).json() as {
      id: string;
    };
    await inject({ method: "POST", url: `/api/users/${u.id}/memories`, payload: { content: "b" } });

    const del = await inject({ method: "DELETE", url: `/api/memories/${a.id}` });
    expect(del.statusCode).toBe(200);
    expect(listMemories(u.id).map((m) => m.content)).toEqual(["b"]);

    const clear = await inject({ method: "DELETE", url: `/api/users/${u.id}/memories` });
    expect(clear.statusCode).toBe(200);
    expect((clear.json() as { removed: number }).removed).toBe(1);
    expect(listMemories(u.id)).toEqual([]);
  });

  it("write-throughs the legacy `memory` patch into the structured store", async () => {
    const u = createUser("u");
    const res = await inject({
      method: "PATCH",
      url: `/api/users/${u.id}`,
      payload: { memory: "- likes tea\n- lives in Beijing" },
    });
    expect(res.statusCode).toBe(200);
    expect(listMemories(u.id).map((m) => m.content)).toEqual(["likes tea", "lives in Beijing"]);
    // Replacing again clears the previous set rather than appending.
    await inject({ method: "PATCH", url: `/api/users/${u.id}`, payload: { memory: "only one" } });
    expect(listMemories(u.id).map((m) => m.content)).toEqual(["only one"]);
  });

  it("consolidates one user or all users", async () => {
    const a = createUser("a");
    const b = createUser("b");
    addMemory(a.id, "重复 事实");
    addMemory(a.id, "重复事实");
    const one = await inject({ method: "POST", url: `/api/users/${a.id}/memories/consolidate` });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { merged: number }).merged).toBe(1);
    const missing = await inject({ method: "POST", url: "/api/users/nope/memories/consolidate" });
    expect(missing.statusCode).toBe(404);

    const all = await inject({ method: "POST", url: "/api/memories/consolidate" });
    expect(all.statusCode).toBe(200);
    const results = (all.json() as { results: Array<{ userId: string }> }).results;
    expect(results.map((r) => r.userId).sort()).toEqual([a.id, b.id].sort());
  });

  it("persists the per-user disabled tool policy", async () => {
    const u = createUser("u");
    const res = await inject({
      method: "PATCH",
      url: `/api/users/${u.id}`,
      payload: { disabledTools: ["bash", "web_fetch"] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { disabledTools: string[] }).disabledTools).toEqual(["bash", "web_fetch"]);
  });

  it("persists a per-user model override", async () => {
    const u = createUser("u");
    const res = await inject({ method: "PATCH", url: `/api/users/${u.id}`, payload: { model: "gpt-4o-mini" } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { model: string }).model).toBe("gpt-4o-mini");
  });

  it("persists per-user disabled skills", async () => {
    const u = createUser("u");
    const res = await inject({ method: "PATCH", url: `/api/users/${u.id}`, payload: { disabledSkills: ["foo"] } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { disabledSkills: string[] }).disabledSkills).toEqual(["foo"]);
  });

  it("lists sessions and returns a session transcript", async () => {
    const u = createUser("u");
    saveMessagesJson(u.id, '[{"role":"user","content":[]}]');
    const list = await inject({ url: `/api/users/${u.id}/sessions` });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { sessions: Array<{ id: string }>; active: string };
    expect(body.sessions).toHaveLength(1);
    expect(body.active).toBe(body.sessions[0]!.id);

    const detail = await inject({ url: `/api/sessions/${body.sessions[0]!.id}` });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { messages: unknown[] }).messages).toHaveLength(1);
    expect((await inject({ url: "/api/sessions/nope" })).statusCode).toBe(404);
  });

  it("records admin actions in the audit log", async () => {
    const created = await inject({ method: "POST", url: "/api/users", payload: { name: "审计用户" } });
    const id = (created.json() as { id: string }).id;
    const res = await inject({ url: `/api/audit?userId=${id}` });
    expect(res.statusCode).toBe(200);
    const entries = (res.json() as { entries: Array<{ action: string }> }).entries;
    expect(entries.some((e) => e.action === "user.create")).toBe(true);
  });

  it("exposes Prometheus metrics without auth", async () => {
    inc("iclaw_test_metric_total");
    const res = await inject({ url: "/metrics", withCookie: false });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("iclaw_test_metric_total 1");
  });

  it("exports and then deletes all of a user's data", async () => {
    const u = createUser("u");
    addMemory(u.id, "喜欢咖啡");

    const exp = await inject({ url: `/api/users/${u.id}/export` });
    expect(exp.statusCode).toBe(200);
    const dump = exp.json() as { user: { id: string }; memories: unknown[] };
    expect(dump.user.id).toBe(u.id);
    expect(dump.memories).toHaveLength(1);

    const del = await inject({ method: "DELETE", url: `/api/users/${u.id}` });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { removed: { user: number } }).removed.user).toBe(1);
    expect((await inject({ url: `/api/users/${u.id}/export` })).statusCode).toBe(404);
  });

  it("enforces RBAC: viewers are read-only, owners manage roles", async () => {
    createAdmin("viewer1", "hash", "viewer");
    const viewerCookie = `iclaw_session=${signSession("viewer1")}`;

    const read = await app.inject({ method: "GET", url: "/api/users", headers: { cookie: viewerCookie } });
    expect(read.statusCode).toBe(200);

    const write = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: viewerCookie, "content-type": "application/json" },
      payload: { name: "x" },
    });
    expect(write.statusCode).toBe(403);

    const promote = await inject({ method: "PATCH", url: "/api/admins/viewer1", payload: { role: "admin" } });
    expect(promote.statusCode).toBe(200);
  });

  it("masks MCP secrets in responses and preserves them on save", async () => {
    const put1 = await inject({
      method: "PUT",
      url: "/api/mcp",
      payload: { servers: { gh: { command: "false", env: { TOKEN: "s3cret" } } } },
    });
    expect(put1.statusCode).toBe(200);

    const got = await inject({ url: "/api/mcp" });
    const servers = (got.json() as { servers: Record<string, { env?: Record<string, string> }> }).servers;
    expect(servers.gh!.env!.TOKEN).toBe("***");

    await inject({ method: "PUT", url: "/api/mcp", payload: { servers: { gh: { command: "false", env: { TOKEN: "***" } } } } });
    expect(loadMcpServers().gh!.env!.TOKEN).toBe("s3cret");
  });

  it("manages invites and validates onboarding codes", async () => {
    const created = await inject({ method: "POST", url: "/api/invites", payload: { note: "n" } });
    expect(created.statusCode).toBe(200);
    const code = (created.json() as { code: string }).code;

    const list = await inject({ url: "/api/invites" });
    expect((list.json() as unknown[]).length).toBe(1);

    // Public validity checks (no admin cookie needed).
    const ok = await app.inject({ method: "GET", url: `/api/onboard/${code}` });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { valid: boolean }).valid).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/onboard/nope" })).statusCode).toBe(404);

    markInviteUsed(code, "someone");
    expect((await app.inject({ method: "GET", url: `/api/onboard/${code}` })).statusCode).toBe(409);
  });
});
