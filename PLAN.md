# IClaw — WeChat ↔ Pi Agent 独立服务

把腾讯官方 OpenClaw 微信插件（`Tencent/openclaw-weixin`）的 **iLink HTTP 客户端**提取出来，
接入 [Pi Agent](https://github.com/earendil-works/pi)（`pi-agent-core`），做成一个独立服务。
多用户各自微信绑定同一个 Pi agent，会话/人设/记忆按用户隔离，工具全员共享，附 Web 管理端。

## 共识决策（grilling 结论）

| # | 决策 | 结论 |
|---|------|------|
| 1 | 交付形态 | 独立 Node 服务，甩掉 OpenClaw |
| 2 | 微信接入 | 提取 iLink HTTP 客户端（扫码登录 + 长轮询 + 发送 + 上传 + 收图解密） |
| 3 | 拓扑 | 每用户一个 bot 微信账号（iLink 网关按「扫码微信 = 独立 bot」1:1 分配；扫码后用户微信中出现专属 Bot 好友）；只做私聊，不做群聊 |
| 4 | 准入 | 扫码即绑定：管理员生成绑定二维码 → 用户扫码授权 → 网关返回 bot 账号与微信 id → 落库绑定（无需邀请码） |
| 5 | profile | per-user 隔离「会话 + 人设 + 记忆」；工具/skill/MCP 全员共享 |
| 6 | 记忆 | 静态资料卡 + 「记住/忘记」工具；不做全自动抽取 |
| 7 | skill/mcp | skill = Pi 原生 Skills；mcp = 官方 MCP SDK 注册为 Pi 原生 tool（调研后替代 pi-mcp-adapter）；管理深度=中（开关/配置 + 上传/git 新增 + 连接健康/工具列表），无市场 |
| 8 | 存储 | SQLite 单文件单节点（node:sqlite）；Pi 会话 transcript 以 JSON 存业务库 `sessions` 表（每轮保存，上限 200 条按轮裁剪）；业务数据同库 |
| 9 | Web 端 | Vite + React SPA + Fastify API 同进程；简单管理员账号（scrypt + session cookie） |
| 10 | 消息范围 | 收文本 + 收图（图→多模态模型）；发文本 |
| 11 | 模型 | 全局单一模型，pi-ai provider 配置 |
| 12 | 护栏 | 仅「管理员冻结/封禁用户」 |
| 13 | botAgent | 自报 `IClaw/1.0`，不伪装 OpenClaw |

## 数据流

```
用户微信 ◄── 扫码授权 ── 腾讯 iLink 网关（一个微信 = 一个 bot 账号）
   ▲                        ▲
   │ 与专属 Bot 好友聊天     │ getupdates 长轮询（每 bot 一条通道）
   │                        │
 iLink 客户端 ◄── Bot 路由（bot账号→用户）──► Pi Agent (pi-agent-core)
                                              · 共享: system prompt + tools
                                              · per-user: 会话 / 人设 / 记忆
                                              · tools = skills + mcp(MCP SDK)
                                                     │
                                    Fastify API + React SPA ─┘ SQLite (node:sqlite)
```

## 阶段

- **Phase 0** — 读源码 + License（✅ MIT）+ 搭骨架
- **Phase 1** — iLink 微信通道 + 回显 bot
- **Phase 2** — Pi Agent 接入（per-user 会话、skills/mcp、人设/记忆）
- **Phase 3** — 数据层 + 扫码即绑定（bot 账号 ↔ 用户）
- **Phase 4** — Web 管理端（含绑定二维码）
- **Phase 5** — 护栏 + 文档 + 部署

## 目录

```
src/
  config.ts            # 运行时配置（env）
  logger.ts, redact.ts, random.ts
  wechat/              # 从插件提取的 iLink 客户端（MIT，保留版权声明）
    types.ts, api.ts, login-qr.ts（扫码会话状态机）, accounts.ts,
    bind-driver.ts（绑定驱动）, binding.ts（落库绑定/解绑）,
    channel.ts（动态通道管理器）, sync-buf.ts, context-token.ts,
    inbound.ts, send.ts, monitor.ts
    cdn/{aes-ecb,cdn-url,pic-decrypt}.ts, media-download.ts
  agent/               # Pi 接入：runtime.ts, models.ts, skills.ts, tools.ts, mcp.ts
  db/                  # node:sqlite 封装 + schema（users/bot_bindings/sessions/admins）
  server/              # Fastify：index.ts, auth.ts, app.ts（含绑定二维码 API）
  web/                 # Vite + React
```

## 依赖

- 运行时：fastify、@fastify/cookie、@fastify/static、qrcode（服务端 SVG 二维码）、
  qrcode-terminal、zod、@earendil-works/pi-agent-core、@earendil-works/pi-ai、@modelcontextprotocol/sdk
- 存储：Node 内置 `node:sqlite`（免原生依赖）
- 密码哈希：Node 内置 `crypto.scrypt`
