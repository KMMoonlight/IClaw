# IClaw

微信 ↔ [Pi Agent](https://github.com/earendil-works/pi) 的独立桥接服务。

从腾讯官方 OpenClaw 微信插件 [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)（MIT）提取 iLink
HTTP 客户端，接入 Pi Agent 作为后端大脑。多用户各自微信绑定**同一个** Pi agent，但**会话 / 人设 / 记忆按用户隔离**，
工具（skill + MCP）全员共享，附带一个 Web 管理端。

## 架构

```
微信用户 ──► 腾讯 iLink 网关 ◄── iLink 客户端(长轮询/发送/收图解密)
                                    │
                           Bot 路由（邀请制绑定 openid→用户）
                                    │
                    Pi Agent (pi-agent-core)          ┌─ SQLite (node:sqlite)
                    · 共享: system prompt + tools      │   ├ 会话(每用户 transcript)
                    · per-user: 会话 / 人设 / 记忆      │   └ 用户/绑定/邀请码/管理员
                    · tools = skills + MCP(原生 tool)  │
                                    │                  │
                      Fastify API + React SPA ─────────┘
```

## 快速开始

```bash
npm install
cp .env.example .env                              # 填模型 provider/model/baseUrl/apiKey

# 1. 登录微信 bot（扫码）
npm run login

# 2. 创建一个用户 + 邀请码（也可在 Web 端操作）
npm run create-user -- 张三

# 3. 启动服务（管理端 + 微信通道，单进程）
npm run serve          # 或 npm run dev
# 管理端：http://127.0.0.1:3000 （首次启动会在日志打印管理员密码）
```

也可以只跑微信通道（不启动 Web）用 `npm run run`；用 `npm run echo` 以回显模式验证微信通道本身。

## 使用流程

1. 管理员登录 Web 端，新建用户 → 生成邀请码。
2. 该用户用微信加 bot 为好友，把邀请码发给 bot。
3. bot 绑定其微信到该用户，之后即可对话；每人会话/记忆独立。

## 配置（`.env`）

| 环境变量 | 说明 | 默认 |
|----------|------|------|
| `ICLAW_MODEL_PROVIDER` | provider 名（见下方表） | — |
| `ICLAW_MODEL` | 模型名（必填） | — |
| `ICLAW_MODEL_BASE_URL` | 端点（可选，缺省用 provider 内置地址） | provider 内置 |
| `ICLAW_API_KEY` | API key（必填） | — |
| `ICLAW_SYSTEM_PROMPT` | 全局基础 system prompt | … |
| `ICLAW_STATE_DIR` | SQLite 与凭证目录 | `./data` |
| `ICLAW_SKILLS_DIR` | 技能目录（放 `SKILL.md` 的目录自动发现） | `./skills` |
| `ICLAW_MCP_CONFIG` | MCP 配置路径 | `./mcp.json` |
| `ICLAW_SERVER_HOST` / `ICLAW_SERVER_PORT` | 管理端监听地址 | `127.0.0.1` / `3000` |
| `ICLAW_ADMIN_USER` | 管理员用户名 | `admin` |
| `ICLAW_ADMIN_PASSWORD` | 首次创建管理员的密码（不设则自动生成并打印） | — |

完整见 `.env.example`。

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

- **技能**：Pi 原生 Agent Skills（`SKILL.md` + frontmatter）。放在 `skillsDir` 下自动发现；Web 端可新增/删除。
  描述注入 system prompt，agent 用 `read_skill` 工具按需加载完整说明。
- **MCP**：直接使用 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
  把每个 MCP server 的工具注册为 Pi 原生 tool（stdio / SSE / Streamable HTTP）。
  Web 端可编辑 `mcp.json` 并查看连接状态与工具列表。修改后需重启服务。

> 注：调研阶段原本计划用 `pi-mcp-adapter`，但其面向 Pi coding-agent 的扩展 API（非
> `pi-agent-core` 的 `Agent`），故改为直接用官方 MCP SDK 做原生工具注册，效果等价。

## 护栏

- 管理员可在 Web 端**冻结/解冻**用户：被冻结用户的微信消息会被静默忽略。

## 目录

```
src/
  config.ts  logger.ts  redact.ts  random.ts  bot.ts  cli.ts
  wechat/      # iLink 客户端（提取自 Tencent/openclaw-weixin，MIT）
  agent/       # Pi 接入：models / runtime / skills / tools / mcp
  db/          # node:sqlite 封装 + schema
  server/      # Fastify：app / auth / index
web/           # React 管理端（Vite）
```

## ⚠️ 风险提示

走的是腾讯官方网关 iLink，但本质仍是「个人微信账号自动化」，存在**封号 / 合规**风险。
请用专用小号运行，正式对外前自行评估合规边界。`botAgent` 已自报 `IClaw/1.0`，未伪装 OpenClaw。

## 致谢

微信通道部分代码改编自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT License），
见 `docs/THIRD_PARTY_NOTICES.md`。
