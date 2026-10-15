# IClaw

微信 ↔ [Pi Agent](https://github.com/earendil-works/pi) 的独立桥接服务。

从腾讯官方 OpenClaw 微信插件 [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)（MIT）提取 iLink
HTTP 客户端，接入 Pi Agent 作为后端大脑。**扫码即绑定**：每个用户用自己微信扫码授权后，其微信中会出现一个专属
Bot 好友（iLink 网关为每个扫码微信分配独立 bot 账号），与它聊天即与 Pi 对话；**会话/人设/记忆按用户隔离**，
工具（skill + MCP）全员共享，附带一个 Web 管理端。

## 架构

```
用户微信 ◄── 扫码授权 ── 腾讯 iLink 网关（一个微信 = 一个独立 bot 账号）
   ▲                        ▲
   │ 与专属 Bot 好友聊天     │ getupdates 长轮询（每个 bot 账号一条通道）
   │                        │
 iLink 客户端 ◄── 路由：bot账号 → 用户 ──► Pi Agent (pi-agent-core)
                                              · 共享: system prompt + tools
                                              · per-user: 会话 / 人设 / 记忆
                                              · tools = skills + MCP(原生 tool)
                                                     │
                                    Fastify API + React SPA ─┘ SQLite (node:sqlite)
```

## 快速开始

```bash
npm install
cp .env.example .env                              # 填模型 provider/model/baseUrl/apiKey

# 1. 启动服务（管理端 + 微信通道，单进程）
npm run serve          # 或 npm run dev
# 管理端：http://127.0.0.1:3000 （首次启动会在日志打印管理员密码）

# 2. Web 端新建用户 → 点「绑定二维码」，让该用户用手机微信扫码并确认授权
#    也可用命令行完成同一件事：npm run bind -- 张三
```

也可以只跑微信通道（不启动 Web）用 `npm run run`；用 `npm run echo` 以回显模式验证微信通道本身。

## 使用流程

1. 管理员在 Web 端（或 `npm run bind -- <名字>`）新建用户，生成绑定二维码。
2. 用户用手机微信扫码并确认授权——其微信中会出现一个**专属 Bot 好友**（仅本人可见）。
3. 用户与该 Bot 好友聊天，即与 Pi 对话；每人会话/人设/记忆独立。扫码即完成绑定，无需其他操作。

> 会话与上下文：每用户会话存于业务 SQLite。**上下文管理**是双层的——① token 感知压缩：当估算
> token 数超过 `ICLAW_MODEL_CONTEXT_WINDOW - 16k` 时，用模型把更早的对话生成摘要，替换旧记录（保留
> 最近 ~20k token 原文，对齐轮次边界；摘要失败则只保留近期原文）；② 兜底硬上限 400 条消息。
> **开启新会话**：用户在微信里发 `/new`（或 `/新会话`），或在 Web 用户页点「新会话」，即清空该用户的
> 对话历史（人设/记忆不受影响）。agent 空闲 24 小时后从内存卸载（重启后从库恢复）。
> 每个已绑定用户的 bot 账号各起一条监控通道，新绑定即时生效（无需重启）；`echo` 模式则对全部已注册账号生效。
> AI 生成回复期间会通过 iLink 向微信发送「对方正在输入…」指示（typing_ticket 按用户缓存 24h）。

## 配置（`.env`）

| 环境变量 | 说明 | 默认 |
|----------|------|------|
| `ICLAW_MODEL_PROVIDER` | provider 名（见下方表） | — |
| `ICLAW_MODEL` | 模型名（必填） | — |
| `ICLAW_MODEL_BASE_URL` | 端点（可选，缺省用 provider 内置地址） | provider 内置 |
| `ICLAW_API_KEY` | API key（必填） | — |
| `ICLAW_MODEL_CONTEXT_WINDOW` | 模型上下文窗口（token 数） | `128000` |
| `ICLAW_MODEL_MAX_TOKENS` | 单次回复最大 token 数 | `8192` |
| `ICLAW_MODEL_SUPPORTS_IMAGES` | 模型是否支持图片输入；`false` 时收到的图片转为文字提示 | `true` |
| `ICLAW_SYSTEM_PROMPT` | 全局基础 system prompt | … |
| `ICLAW_LOG_LEVEL` | 日志级别 `debug/info/warn/error` | `info` |
| `ICLAW_STATE_DIR` | SQLite 与凭证目录 | `./data` |
| `ICLAW_SKILLS_DIR` | 技能目录（放 `SKILL.md` 的目录自动发现） | `./skills` |
| `ICLAW_MCP_CONFIG` | MCP 配置路径 | `./mcp.json` |
| `ICLAW_SERVER_HOST` / `ICLAW_SERVER_PORT` | 管理端监听地址 | `127.0.0.1` / `3000` |
| `ICLAW_ADMIN_USER` | 管理员用户名 | `admin` |
| `ICLAW_ADMIN_PASSWORD` | 管理员密码（权威：每次启动同步到库中；不设则首次自动生成并打印） | — |
| `ICLAW_COOKIE_SECURE` | 会话 cookie 带 `Secure` 标志（对外暴露时配 HTTPS 后开启） | `false` |
| `ICLAW_MEMORY_AUTO_EXTRACT` | 每轮对话后自动抽取长期记忆（会额外调用一次模型） | `false` |
| `ICLAW_EMBEDDING_MODEL` | embedding 模型（OpenAI 兼容 `/embeddings`），用于记忆语义检索；不设则降级为关键词 | — |
| `ICLAW_EMBEDDING_BASE_URL` | embedding 端点覆盖；缺省复用 `ICLAW_MODEL_BASE_URL`/provider 内置地址 | — |
| `ICLAW_SCHEDULER_ENABLED` | 启用后台定时任务调度器（提醒 / 周期任务 / 网页监控） | `true` |
| `ICLAW_SCHEDULER_INTERVAL_MS` | 调度器轮询间隔（毫秒） | `30000` |
| `ICLAW_TOOLS_EXEC` | 启用 bash / 文件读写工具（限定在用户 workspace） | `false` |
| `ICLAW_WORKSPACE_DIR` | 执行工具工作目录根 | `<stateDir>/workspaces` |
| `ICLAW_EXEC_TIMEOUT_MS` | 单次命令执行超时（毫秒） | `30000` |
| `ICLAW_EXEC_MAX_OUTPUT_BYTES` | 单次命令输出字节上限 | `100000` |
| `ICLAW_EXEC_SANDBOX` | 沙箱模式 `auto` / `required` / `none` | `auto` |
| `ICLAW_EXEC_ALLOW_NETWORK` | 沙箱内是否允许出站网络 | `false` |
| `ICLAW_APPROVAL_TOOLS` | 可选：需用户确认的工具（逗号分隔）；**默认留空 = 全部直接执行，不做人工审批** | 空 |
| `ICLAW_SEARCH_PROVIDER` | 联网搜索后端 `none` / `tavily` / `brave` / `searxng` | `none` |
| `ICLAW_SEARCH_API_KEY` | 搜索后端 API key（tavily / brave） | — |
| `ICLAW_SEARCH_BASE_URL` | 搜索后端地址（searxng 必填） | — |
| `ICLAW_SEND_CHUNK_CHARS` | 单条消息最大字符数，超过自动分片 | `2000` |
| `ICLAW_STREAM_PROGRESS` | 生成过程中分段推送长回复（流式体验） | `true` |
| `ICLAW_SEND_MEDIA_MAX_BYTES` | `send_file`/`send_image` 文件大小上限（字节） | `20971520` |
| `ICLAW_MODEL_FALLBACK` | 主模型失败时重试的备用模型 | — |
| `ICLAW_USER_DAILY_TOKEN_LIMIT` | 每用户每日 token 上限（0 = 不限） | `0` |
| `ICLAW_USER_RATE_PER_MIN` | 每用户每分钟消息上限（0 = 不限） | `0` |
| `ICLAW_SEND_RETRIES` | 出站发送失败重试次数 | `2` |
| `ICLAW_OUTBOUND_BLOCKLIST` | 出站内容黑名单（正则，逗号分隔） | — |
| `ICLAW_OUTBOUND_BLOCK_MESSAGE` | 命中黑名单时的替代文本 | `抱歉，这条内容不适合发送。` |
| `ICLAW_DATA_RETENTION_DAYS` | 数据保留天数（0 = 永久保留） | `0` |

完整见 `.env.example`。需要 Node.js ≥ 22.13（`node:sqlite` 免 flag）；22.5–22.12 需加 `--experimental-sqlite` 启动参数。

### 支持的 provider

`ICLAW_MODEL_PROVIDER` 可取以下值；未列出的 provider 按 OpenAI chat completions 兼容处理，且必须显式设置 `ICLAW_MODEL_BASE_URL`。

| `ICLAW_MODEL_PROVIDER` | 协议 | 默认 `ICLAW_MODEL_BASE_URL` | 说明 |
|------------------------|------|------------------------------|------|
| `openai` | openai-completions | `https://api.openai.com/v1` | OpenAI chat completions |
| `openai-responses` | openai-responses | `https://api.openai.com/v1` | OpenAI Responses API |
| `anthropic` | anthropic-messages | `https://api.anthropic.com` | Anthropic Claude |
| `deepseek` | openai-completions | `https://api.deepseek.com` | DeepSeek |
| `qwen` | openai-completions | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 通义千问（DashScope） |
| `moonshot` | openai-completions | `https://api.moonshot.cn/v1` | Kimi 开放平台（按量） |
| `kimi-code` | anthropic-messages | `https://api.kimi.com/coding` | Kimi 编程会员（订阅，Bearer 鉴权） |
| `zhipu` | openai-completions | `https://open.bigmodel.cn/api/paas/v4` | 智谱 GLM |
| `siliconflow` | openai-completions | `https://api.siliconflow.cn/v1` | 硅基流动 |
| `volcengine` | openai-completions | `https://ark.cn-beijing.volces.com/api/v3` | 火山引擎（豆包） |
| `stepfun` | openai-completions | `https://api.stepfun.com/v1` | 阶跃星辰 |
| `baichuan` | openai-completions | `https://api.baichuan-ai.com/v1` | 百川智能 |
| `zai` | openai-completions | `https://api.z.ai/api/paas/v4` | 智谱 Z.ai（国际） |
| `minimax` | openai-completions | `https://api.minimax.chat/v1` | MiniMax |
| `spark` | openai-completions | `https://spark-api-open.xf-yun.com/v1` | 讯飞星火 |
| `mistral` | openai-completions | `https://api.mistral.ai/v1` | Mistral |
| `openrouter` | openai-completions | `https://openrouter.ai/api/v1` | OpenRouter 聚合 |
| `groq` | openai-completions | `https://api.groq.com/openai/v1` | Groq |
| `together` | openai-completions | `https://api.together.xyz/v1` | Together AI |
| `fireworks` | openai-completions | `https://api.fireworks.ai/inference/v1` | Fireworks AI |
| `xai` | openai-completions | `https://api.x.ai/v1` | xAI Grok |
| `cerebras` | openai-completions | `https://api.cerebras.ai/v1` | Cerebras |
| `nvidia` | openai-completions | `https://integrate.api.nvidia.com/v1` | NVIDIA NIM |
| `google` | openai-completions | `https://generativelanguage.googleapis.com/v1beta/openai/` | Gemini（OpenAI 兼容） |
| `ollama` | openai-completions | `http://localhost:11434/v1` | 本地 Ollama |

协议固定值（iLink 网关地址、CDN 地址、`botAgent=IClaw/1.0`、`bot_type=3`）已作为常量硬编码在 `src/config.ts`，无需配置。

## 技能与 MCP

- **技能**：Pi 原生 Agent Skills（`SKILL.md` + frontmatter）。放在 `skillsDir` 下自动发现；Web 端可新增/删除，
  也可以**直接从 GitHub 仓库安装**（粘贴 `owner/repo` 或完整 URL，支持单技能仓库与技能合集，服务端下载解压，无需 git 二进制）。
  描述注入 system prompt，agent 用 `read_skill` 工具按需加载完整说明。
- **MCP**：直接使用 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
  把每个 MCP server 的工具注册为 Pi 原生 tool（stdio / SSE / Streamable HTTP）。
  Web 端可编辑 `mcp.json` 并查看连接状态与工具列表。**保存即热加载**（重新连接 MCP、
  刷新所有会话的工具集），无需重启。
  > 注意：官方参考服务器（含 `@modelcontextprotocol/server-fetch`）已从 npm 下架，
  > 示例见 `mcp.json.example`（`server-github` 仍在维护）。
- **内置联网工具 `web_fetch`**：抓取网页/接口文本（带 SSRF 防护：拒绝内网/本机地址、
  限重定向 3 次、15s 超时、500KB 上限、HTML 转纯文本），无需任何 MCP 配置。

> 注：调研阶段原本计划用 `pi-mcp-adapter`，但其面向 Pi coding-agent 的扩展 API（非
> `pi-agent-core` 的 `Agent`），故改为直接用官方 MCP SDK 做原生工具注册，效果等价。

## 记忆系统

每个用户的长期记忆存于结构化 `memories` 表（`kind` / `content` / `source` / `importance` /
`created_at` / `last_used_at` / `embedding`），取代旧的自由字符串 `users.memory`（旧数据在首次
启动时**自动一次性迁移**，按 `- 事实` 拆行）。

- **写入**：agent 可调用 `remember`（支持 `kind`/`importance`，自动去重）、`forget`（按内容删单条或清空）、
  `list_memories`；也可开启 `ICLAW_MEMORY_AUTO_EXTRACT` 让每轮对话后自动抽取（失败不影响主流程）。
- **检索**：每轮按**当前用户消息**做相关性召回，而非全量灌入 system prompt。配置了
  `ICLAW_EMBEDDING_MODEL` 时走**向量检索**（cosine + 重要度 + 新近度，缺失向量懒回填）；未配置或调用失败时
  **自动降级为关键词检索**（英文整词 + 中文 bigram 重叠度）。结果受字符预算（≤4000 字）限制。
- **整理**：`consolidateMemories` 做确定性合并（精确/近似去重保留高重要度）、陈旧低重要度剪枝
  （`profile` 永不删）与每用户上限控制；启动时整体跑一次，也可用
  `POST /api/memories/consolidate`（全部）或 `POST /api/users/:id/memories/consolidate`（单个）手动触发。
- **API**：`/api/users/:id/memories`（GET/POST/DELETE）与 `/api/memories/:id`（PATCH/DELETE）。

## 定时任务与网页监控

后台调度器（`ICLAW_SCHEDULER_ENABLED`，默认开）每 `ICLAW_SCHEDULER_INTERVAL_MS` 轮询一次，
任务/监控项持久化在 SQLite，**重启不丢**。agent 可通过以下内置工具主动为用户服务：

- **提醒 / 周期任务**：`schedule_task` / `list_tasks` / `cancel_task`。`when` 支持
  cron 表达式（如 `0 9 * * *` 每天 9:00）、相对时间（`+10m`/`+2h`/`+1d`）、ISO 时间或毫秒时间戳；
  `mode=agent` 时到点会跑一次对话并把结果发给用户（适合“每天生成早报”），否则发送固定文本。
- **网页监控**：`watch_url` / `list_watchers` / `cancel_watcher`。默认监控页面内容变化，
  给定 `keyword` 时监控关键词出现（absent → present）；触发时把 `prompt` 推送给用户。复用
  `web_fetch` 的 SSRF 防护。

每用户任务/监控项均有上限（任务 20、监控 10）；到点通过用户绑定的 Bot 好友主动推送。

## 工具执行与安全

- **执行类工具**（`bash` / `read_file` / `write_file` / `list_dir`，默认关闭）：开启 `ICLAW_TOOLS_EXEC` 后，
  agent 可在**每用户隔离的 workspace**（`ICLAW_WORKSPACE_DIR`）内读写文件、执行 shell。文件工具强制相对路径，
  拒绝绝对路径与目录穿越；命令有超时（`ICLAW_EXEC_TIMEOUT_MS`）、输出上限（`ICLAW_EXEC_MAX_OUTPUT_BYTES`）与
  最小环境变量白名单。
- **沙箱**（`ICLAW_EXEC_SANDBOX`）：`auto` 时自动使用 `bwrap`（Linux）或 `sandbox-exec`（macOS）隔离——只读系统目录、
  只写 workspace、默认禁网；`required` 时无沙箱工具则拒绝执行；`none` 则不沙箱（不建议）。
- **审批（可选，默认关闭）**：默认所有工具直接执行（全部放行）。如需对个别危险工具加一道人工确认，把工具名配到
  `ICLAW_APPROVAL_TOOLS`（如 `bash,write_file`），这些工具会先要用户在微信回复「同意 / 拒绝」，同意后才执行并把结果发回。
- **工具权限**：管理员可通过 `PATCH /api/users/:id { disabledTools: [...] }` 按用户禁用任意工具。
- **联网搜索**：配置 `ICLAW_SEARCH_PROVIDER` 后自动注册 `web_search`（未配置则不暴露，`web_fetch` 始终可用）。
- **MCP 子进程**：stdio MCP server 只继承安全白名单环境变量（PATH/HOME/…），**不会拿到 `ICLAW_API_KEY` 等密钥**。
- **技能依赖**：`SKILL.md` frontmatter 可声明 `allowed-tools` 与 `requires`，会展示在技能列表/加载结果中。

## 消息输出

- **长回复分片**：超过 `ICLAW_SEND_CHUNK_CHARS`（默认 2000 字）的回复会按段落/句子边界自动拆成多条发送。
- **分段流式**：`ICLAW_STREAM_PROGRESS`（默认开）时，生成中的长回复会**按阈值分段实时推送**，长回答不会让用户干等。
- **出站媒体**：内置 `send_file` / `send_image` 工具，可把工作目录内的图片/视频/文件上传到微信 CDN 并发给用户
  （AES-128-ECB 加密上传，大小上限 `ICLAW_SEND_MEDIA_MAX_BYTES`）。
- **入站媒体**：文本/图片/语音（转写）/文件均可接收；图片交给多模态模型，文件以「附件」文字提示交给模型。

## 平台能力

- **多模型**：`users.model` 可按用户覆盖模型（`PATCH /api/users/:id { model }`）；`ICLAW_MODEL_FALLBACK`
  在主模型失败时自动重试一次。
- **用量与成本**：每轮记录 provider 上报的 token/费用到 `usage` 表；`GET /api/users/:id/usage`、`GET /api/usage`。
- **配额/限流**：`ICLAW_USER_DAILY_TOKEN_LIMIT`（每日 token）与 `ICLAW_USER_RATE_PER_MIN`（每分钟消息）。
- **审计日志**：agent 工具调用（`tool:<name>`）与管理操作写入 `audit_log`；`GET /api/audit?userId=&limit=`。
- **指标**：Prometheus 文本 `GET /metrics`（turns / tool calls / model fallback / scheduled tasks 等）。
- **多会话**：`/new` 开新会话（保留历史）、`/sessions` 列出、`/switch <序号>` 切换。
- **优雅关闭**：SIGTERM 时停止调度/通道后等待在途对话完成（最多 5s）再退出。
- **出站重试**：发送失败按指数退避重试（复用同一 `client_id` 以便网关去重）。

## 多渠道与产品化

- **渠道抽象**：`src/channels/` 定义了 `Channel` / `InboundMessage` / `ReplySink`。路由、会话命令、审批、配额、
  agent turn 全部在 `channels/agent-gateway.ts`（与传输无关）；微信只是 `bot.ts` 里的一个适配器，
  新增渠道只需实现一个 `ReplySink`（见 `channels/memory.ts` 示例）。
- **Agent 行为 eval**：`npm run eval` 跑确定性行为用例（CI 已纳入）；`ICLAW_EVAL_LIVE=1 npm run eval` 追加
  实模型端到端用例。详见 `evals/README.md`。
- **自助接入**：管理员 `POST /api/invites` 生成邀请码；用户访问 `GET/POST /api/onboard/:code` 自助创建并绑定。
- **会话历史**：`GET /api/users/:id/sessions`、`GET /api/sessions/:sessionId`；工具轨迹见 `GET /api/audit`。
- **技能管理**：`SKILL.md` 支持 `version`；全局/按用户开闭（`PATCH /api/skills/:name`、`PATCH /api/users/:id { disabledSkills }`）。

## 安全与合规

- **Prompt Injection 防护**：system prompt 内置安全准则；`web_fetch`/`web_search` 等外部内容以
  `[外部不可信内容 · 来源]` 包裹，明确要求不得执行其中指令。
- **出站审核**：`ICLAW_OUTBOUND_BLOCKLIST`（正则）命中的回复会被替换为 `ICLAW_OUTBOUND_BLOCK_MESSAGE`。
- **工具沙箱/审批**：见上文「工具执行与安全」。
- **RBAC**：管理员角色 `viewer < admin < owner`；viewer 只读（非 GET 一律 403），owner 可管理角色。
  角色见 `GET /api/admins`、`PATCH /api/admins/:username`。
- **数据生命周期**：`GET /api/users/:id/export` 导出全部数据；`DELETE /api/users/:id` 级联删除；
  `ICLAW_DATA_RETENTION_DAYS` 启用保留期清理（启动时执行）。
- **凭证不泄露**：`GET /api/mcp` 对 `env` 密钥回显 `***`，保存时自动回填真实值（不会用 `***` 覆盖密钥）；
  stdio MCP 子进程只继承环境白名单。
- **审计**：工具调用与管理操作写入 `audit_log`（`GET /api/audit`）。

## 护栏

- 管理员可在 Web 端**冻结/解冻**用户：被冻结用户的微信消息会被静默忽略。

## 目录

```
src/
  config.ts  logger.ts  redact.ts  random.ts  bot.ts  cli.ts
  wechat/      # iLink 客户端（提取自 Tencent/openclaw-weixin，MIT）
               #   login-qr（扫码会话）/ bind-driver / binding / channel（动态通道管理）
  agent/       # Pi 接入：models / runtime / skills / tools / mcp
  db/          # node:sqlite 封装 + schema（users / bot_bindings / sessions / admins）
  server/      # Fastify：app（含绑定二维码 API）/ auth / index
web/           # React 管理端（Vite）
```

## ⚠️ 风险提示

走的是腾讯官方网关 iLink，但本质仍是「个人微信账号自动化」，存在**封号 / 合规**风险。
且每个用户绑定的是**其本人的微信号**（其微信中出现的专属 Bot 好友背后即其本人账号），
请务必在用户知情同意的前提下使用，正式对外前自行评估合规边界。`botAgent` 已自报 `IClaw/1.0`，未伪装 OpenClaw。

## 部署

生产部署（Docker Compose / systemd / HTTPS 反代 / 备份运维）见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。

## 致谢

微信通道部分代码改编自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT License），
见 `docs/THIRD_PARTY_NOTICES.md`。
