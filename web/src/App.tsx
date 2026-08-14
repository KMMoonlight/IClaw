import { useCallback, useEffect, useState } from "react";

interface User {
  id: string;
  name: string;
  persona: string;
  memory: string;
  status: "active" | "frozen";
  botAccount: string | null;
  wechatUserId: string | null;
}

interface Skill {
  name: string;
  description: string;
}

interface McpServer {
  name: string;
  configured: boolean;
  error?: string;
  tools: string[];
}

interface McpConfig {
  servers: Record<string, { command?: string; args?: string[]; url?: string; disabled?: boolean }>;
  status: McpServer[];
}

interface BindStatus {
  phase: string;
  message: string;
  qrSvg?: string | null;
  verifyRequired?: boolean;
  connected?: boolean;
  bound?: boolean;
  accountId?: string;
  wechatUserId?: string;
}

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  // Only send the JSON content-type when there IS a body: Fastify rejects
  // empty bodies with a JSON content-type (400 Bad Request).
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; details?: { fieldErrors?: Record<string, unknown> } };
    const fieldErrors = body.details?.fieldErrors;
    const detail = fieldErrors && Object.keys(fieldErrors).length > 0 ? `：${JSON.stringify(fieldErrors)}` : "";
    throw new Error((body.error ?? `HTTP ${res.status}`) + detail);
  }
  return res.json() as Promise<T>;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="login-wrap card">
      <h1>IClaw 管理端</h1>
      <p className="muted">请登录管理员账号</p>
      <form onSubmit={submit}>
        <label>用户名</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <label>密码</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="err">{error}</div>}
        <div style={{ marginTop: 16 }}>
          <button className="primary" type="submit">登录</button>
        </div>
      </form>
    </div>
  );
}

function BindModal({ user, onClose, onBound }: { user: User; onClose: () => void; onBound: () => void }) {
  const [status, setStatus] = useState<BindStatus | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    // Poll only after the bind session has actually been created.
    const startPolling = () => {
      timer = setInterval(() => {
        api<BindStatus>(`/api/users/${user.id}/bind/status`)
          .then((s) => {
            if (stopped) return;
            setStatus(s);
            if (s.connected && s.bound) {
              clearInterval(timer);
              onBound();
            }
          })
          .catch(() => { /* transient; keep polling */ });
      }, 2000);
    };

    void api<BindStatus>(`/api/users/${user.id}/bind`, { method: "POST" })
      .then((s) => {
        if (stopped) return;
        setStatus(s);
        startPolling();
      })
      .catch((e) => { if (!stopped) setErr(e instanceof Error ? e.message : String(e)); });

    const cancelOnLeave = () => {
      void api(`/api/users/${user.id}/bind/cancel`, { method: "POST" }).catch(() => {});
    };
    window.addEventListener("beforeunload", cancelOnLeave);

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("beforeunload", cancelOnLeave);
    };
  }, [user.id, onBound]);

  const submitCode = async () => {
    if (!code.trim()) return;
    await api(`/api/users/${user.id}/bind/verify`, { method: "POST", body: JSON.stringify({ code }) });
    setCode("");
  };

  const cancel = async () => {
    await api(`/api/users/${user.id}/bind/cancel`, { method: "POST" }).catch(() => {});
    onClose();
  };

  const done = status?.connected && status.bound;

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) void cancel(); }}>
      <div className="modal card">
        <h2>绑定微信（{user.name}）</h2>
        {err && <div className="err">{err}</div>}
        {!err && status?.qrSvg && (
          <div className="qr-wrap" dangerouslySetInnerHTML={{ __html: status.qrSvg }} />
        )}
        {!err && status && !status.qrSvg && done && <div className="success">✅ 绑定成功</div>}
        {!err && status && (
          <p className={`muted ${status.phase === "need_verifycode" ? "err" : ""}`} style={{ textAlign: "center" }}>
            {status.message}
          </p>
        )}
        {!err && status?.verifyRequired && (
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="输入手机微信上显示的数字"
              autoFocus
            />
            <button className="primary" onClick={submitCode}>提交</button>
          </div>
        )}
        <div className="modal-help muted">
          让用户用手机微信扫描二维码，并在手机上确认授权。<br />
          扫码后其微信中会出现一个专属 Bot 好友，与之聊天即与 Pi 对话。
        </div>
        {done && (
          <div className="success">
            绑定成功：Bot 账号 {status?.accountId ?? ""}（微信 {status?.wechatUserId ?? ""}）
          </div>
        )}
        <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={done ? onClose : cancel}>{done ? "关闭" : "取消"}</button>
        </div>
      </div>
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [bindUser, setBindUser] = useState<User | null>(null);
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [err, setErr] = useState("");

  const reload = useCallback(async () => {
    setUsers(await api<User[]>("/api/users"));
  }, []);

  useEffect(() => {
    reload().catch((e) => setErr(String(e)));
  }, [reload]);

  const create = async () => {
    if (!name.trim()) return;
    await api("/api/users", { method: "POST", body: JSON.stringify({ name, persona }) });
    setName("");
    setPersona("");
    reload();
  };

  const toggleStatus = async (u: User) => {
    await api(`/api/users/${u.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: u.status === "active" ? "frozen" : "active" }),
    });
    reload();
  };

  const unbind = async (u: User) => {
    if (!window.confirm(`确定解除 ${u.name} 的微信绑定吗？其微信中的 Bot 好友将不再响应。`)) return;
    await api(`/api/users/${u.id}/unbind`, { method: "POST" });
    reload();
  };

  const resetSession = async (u: User) => {
    if (!window.confirm(`确定清空 ${u.name} 的对话历史（开启新会话）吗？`)) return;
    await api(`/api/users/${u.id}/session/reset`, { method: "POST" });
    reload();
  };

  const editPersona = async (u: User) => {
    const p = window.prompt("编辑该用户的人设（补充 system prompt）", u.persona);
    if (p === null) return;
    await api(`/api/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ persona: p }) });
    reload();
  };

  const handleBound = useCallback(() => {
    void reload();
  }, [reload]);

  return (
    <div>
      <div className="card">
        <h2>新建用户</h2>
        <div className="row">
          <div>
            <label>名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="用户昵称" />
          </div>
          <div>
            <label>人设（可选）</label>
            <input value={persona} onChange={(e) => setPersona(e.target.value)} placeholder="补充 system prompt" />
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="primary" onClick={create}>创建用户</button>
        </div>
        {err && <div className="err">{err}</div>}
      </div>

      <div className="card">
        <h2>用户</h2>
        <table>
          <thead>
            <tr><th>名称</th><th>人设</th><th>状态</th><th>绑定 Bot</th><th>操作</th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="muted">{u.persona || "—"}</td>
                <td><span className={`badge ${u.status}`}>{u.status === "active" ? "正常" : "已冻结"}</span></td>
                <td className="muted">
                  {u.botAccount
                    ? <span className="code">{u.botAccount}</span>
                    : "未绑定"}
                  {u.wechatUserId ? <div style={{ fontSize: 12 }}>{u.wechatUserId}</div> : null}
                </td>
                <td>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {u.botAccount
                      ? <button className="small" onClick={() => setBindUser(u)}>重新绑定</button>
                      : <button className="small primary" onClick={() => setBindUser(u)}>绑定二维码</button>}
                    {u.botAccount && <button className="small danger" onClick={() => unbind(u)}>解绑</button>}
                    <button className="small" onClick={() => resetSession(u)}>新会话</button>
                    <button className="small" onClick={() => editPersona(u)}>编辑人设</button>
                    <button className={`small ${u.status === "active" ? "danger" : ""}`} onClick={() => toggleStatus(u)}>
                      {u.status === "active" ? "冻结" : "解冻"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: 12 }}>
          绑定流程：点「绑定二维码」→ 用户用手机微信扫码并确认 → 其微信中出现专属 Bot 好友，与之聊天即与 Pi 对话（会话/人设/记忆按用户隔离）。
        </p>
      </div>

      {bindUser && (
        <BindModal
          user={bindUser}
          onClose={() => setBindUser(null)}
          onBound={handleBound}
        />
      )}
    </div>
  );
}

function SkillsTab() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState("");

  const reload = useCallback(async () => {
    setSkills(await api<Skill[]>("/api/skills"));
  }, []);

  useEffect(() => {
    reload().catch((e) => setErr(String(e)));
  }, [reload]);

  const add = async () => {
    if (!name.trim() || !body.trim()) return;
    await api("/api/skills", { method: "POST", body: JSON.stringify({ name, description, body }) });
    setName("");
    setDescription("");
    setBody("");
    reload();
  };

  const remove = async (n: string) => {
    if (!window.confirm(`确定删除技能「${n}」吗？`)) return;
    await api(`/api/skills/${encodeURIComponent(n)}`, { method: "DELETE" });
    reload();
  };

  return (
    <div>
      <div className="card">
        <h2>新增技能</h2>
        <label>名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-skill" />
        <label>描述</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="这个技能做什么、何时用" />
        <label>SKILL.md 内容</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="# 技能说明…" />
        <div style={{ marginTop: 12 }}>
          <button className="primary" onClick={add}>新增技能</button>
        </div>
        {err && <div className="err">{err}</div>}
      </div>

      <div className="card">
        <h2>技能列表</h2>
        <table>
          <thead><tr><th>名称</th><th>描述</th><th></th></tr></thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.name}>
                <td className="code">{s.name}</td>
                <td className="muted">{s.description || "—"}</td>
                <td><button className="small danger" onClick={() => remove(s.name)}>删除</button></td>
              </tr>
            ))}
            {skills.length === 0 && <tr><td className="muted" colSpan={3}>暂无技能（把 SKILL.md 目录放到 skills/ 下也会被自动发现）</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function McpTab() {
  const [data, setData] = useState<McpConfig | null>(null);
  const [json, setJson] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const reload = useCallback(async () => {
    const d = await api<McpConfig>("/api/mcp");
    setData(d);
    setJson(JSON.stringify(d.servers, null, 2));
  }, []);

  useEffect(() => {
    reload().catch((e) => setErr(String(e)));
  }, [reload]);

  const save = async () => {
    try {
      const servers = JSON.parse(json);
      await api("/api/mcp", { method: "PUT", body: JSON.stringify({ servers }) });
      setMsg("已保存。注意：已运行的会话不会自动加载新 MCP 工具，需重启服务。");
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="card">
        <h2>MCP 服务器配置</h2>
        <p className="muted">编辑 mcpServers JSON（与 .mcp.json 同格式），保存后重启服务生效。</p>
        <textarea value={json} onChange={(e) => setJson(e.target.value)} style={{ minHeight: 180, fontFamily: "monospace" }} />
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button className="primary" onClick={save}>保存</button>
          <button onClick={reload}>刷新状态</button>
        </div>
        {msg && <div className="success">{msg}</div>}
        {err && <div className="err">{err}</div>}
      </div>

      <div className="card">
        <h2>连接状态</h2>
        <table>
          <thead><tr><th>服务器</th><th>状态</th><th>工具</th></tr></thead>
          <tbody>
            {(data?.status ?? []).map((s) => (
              <tr key={s.name}>
                <td className="code">{s.name}</td>
                <td>
                  {s.configured
                    ? <span className="badge connected">已连接</span>
                    : <span className="badge error" title={s.error}>未连接</span>}
                </td>
                <td className="muted">{s.tools.join(", ") || "—"}</td>
              </tr>
            ))}
            {(data?.status ?? []).length === 0 && <tr><td className="muted" colSpan={3}>暂无 MCP 服务器</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"users" | "skills" | "mcp">("users");

  useEffect(() => {
    api("/api/auth/me")
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setAuthed(false);
  };

  if (authed === null) return <div className="container muted">加载中…</div>;
  if (authed === false) return <Login onLogin={() => setAuthed(true)} />;

  return (
    <div className="container">
      <div className="topbar">
        <h1>IClaw 管理端</h1>
        <button onClick={logout}>退出登录</button>
      </div>
      <div className="tabs">
        <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>用户</button>
        <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>技能</button>
        <button className={tab === "mcp" ? "active" : ""} onClick={() => setTab("mcp")}>MCP</button>
      </div>
      {tab === "users" && <UsersTab />}
      {tab === "skills" && <SkillsTab />}
      {tab === "mcp" && <McpTab />}
    </div>
  );
}
