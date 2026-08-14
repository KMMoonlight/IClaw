# IClaw — WeChat ↔ Pi Agent 独立服务

把腾讯官方 OpenClaw 微信插件（`Tencent/openclaw-weixin`）的 **iLink HTTP 客户端**提取出来，
接入 [Pi Agent](https://github.com/earendil-works/pi)（`pi-agent-core`），做成一个独立服务。
多用户各自微信绑定同一个 Pi agent，会话/人设/记忆按用户隔离，工具全员共享，附 Web 管理端。

## 共识决策（grilling 结论）

| # | 决策 | 结论 |
|---|------|------|
| 1 | 交付形态 | 独立 Node 服务，甩掉 OpenClaw |
| 2 | 微信接入 | 提取 iLink HTTP 客户端（扫码登录 + 长轮询 + 发送 + 上传 + 收图解密） |
| 3 | 拓扑 | 登录 1 个 bot 微信账号；只做私聊 DM，不做群聊 |
| 4 | 准入 | 邀请制：Web 建用户 → 生成绑定码 → 用户扫码绑定微信 openid |
| 5 | profile | per-user 隔离「会话 + 人设 + 记忆」；工具/skill/MCP 全员共享 |
| 6 | 记忆 | 静态资料卡 + 「记住/忘记」工具；不做全自动抽取 |
| 7 | skill/mcp | skill = Pi 原生 Skills；mcp = pi-mcp-adapter；管理深度=中（开关/配置 + 上传/git 新增 + 连接健康/工具列表），无市场 |
| 8 | 存储 | SQLite 单文件单节点；Pi 会话用自带 SQLite 后端；业务数据同库 |
| 9 | Web 端 | Vite + React SPA + Fastify API 同进程；简单管理员账号（scrypt + session cookie） |
| 10 | 消息范围 | 收文本 + 收图（图→多模态模型）；发文本 |
| 11 | 模型 | 全局单一模型，pi-ai provider 配置 |
| 12 | 护栏 | 仅「管理员冻结/封禁用户」 |
| 13 | botAgent | 自报 `IClaw/1.0`，不伪装 OpenClaw |

## 数据流

```
微信用户 ──► 腾讯 iLink 网关 ◄── iLink 客户端(长轮询/发送/上传)
                                    │
                           WeChat Adapter（openid→profile 路由；消息↔AgentMessage 转换；收图解密）
                                    │
                    Pi Agent (pi-agent-core)          ┌─ SQLite (node:sqlite)
                    · 共享: system prompt + tools      │   ├ 会话(Pi SQLite 后端)
                    · per-user: 会话树/人设/记忆        │   └ 业务数据(用户/绑定/邀请码/记忆/管理员)
                    · tools = skills + mcp(pi-mcp-adapter) │
                                    │                  │
                      Fastify API + React SPA ─────────┘
```

## 阶段

- **Phase 0** — 读源码 + License（✅ MIT）+ 搭骨架
- **Phase 1** — iLink 微信通道 + 回显 bot
- **Phase 2** — Pi Agent 接入（per-user 会话、skills/mcp、人设/记忆）
- **Phase 3** — 数据层 + 邀请制
- **Phase 4** — Web 管理端
- **Phase 5** — 护栏 + 文档 + 部署

## 目录

```
src/
  config.ts            # iclaw.config.json 读取（baseUrl/botAgent/模型/skill路径等）
  logger.ts, redact.ts, random.ts
  wechat/              # 从插件提取的 iLink 客户端（MIT，保留版权声明）
    types.ts, api.ts, login-qr.ts, accounts.ts,
    sync-buf.ts, context-token.ts, inbound.ts, send.ts, monitor.ts
    cdn/{aes-ecb,cdn-url,pic-decrypt}.ts, media-download.ts
  agent/               # Pi 接入：pi-agent.ts, skills.ts, mcp.ts, memory.ts
  db/                  # node:sqlite 封装 + schema
  server/              # Fastify：index.ts, auth.ts, routes/
  web/                 # Vite + React
```

## 依赖

- 运行时：fastify、@fastify/cookie、@fastify/static、qrcode-terminal、zod、
  @earendil-works/pi-agent-core、@earendil-works/pi-ai、@earendil-works/pi-session-backend-sqlite-node、pi-mcp-adapter
- 存储：Node 内置 `node:sqlite`（免原生依赖）
- 密码哈希：Node 内置 `crypto.scrypt`
