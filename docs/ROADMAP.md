# IClaw 优化 Roadmap

> 结论：IClaw 是一个做得扎实的「微信渠道 + Pi Agent 桥接器」（单进程、100+ 单测、扫码即绑定、
> skills/MCP 热加载、token 感知压缩），但当前形态是 **"Chatbot over WeChat"**，距离成熟的
> Personal Agent 还差在 **主动性、记忆深度、工具执行、多模态、平台工程化** 五个维度。
>
> 一句话：**管道已建好且质量不错，缺的是管道后面那个"会主动、有长期记忆、能真正动手做事"的 agent 大脑。**

---

## 1. Agent 自主性（差距最大）

| 能力 | 成熟 Personal Agent | IClaw 现状 |
|---|---|---|
| 主动/定时任务 | 日程提醒、cron 触发、后台任务、事件订阅 | **完全没有**（全仓库 grep 不到 schedule/cron/reminder） |
| 长任务/规划 | plan → 子任务 → 执行 → 反思 | 只有单轮 `agent.prompt()`（`runtime.ts`），无 plan/subagent |
| 触发式行为 | 邮件到达、网页监控、日历事件触发 | 仅被动响应微信消息 |
| 工具审批 | 危险操作需用户确认 | 无任何 approval/permission 层 |

成熟产品让 agent **主动找你**；IClaw 只能等你发消息。这是形态级差距，不是功能补丁。

---

## 2. 记忆系统（表面有，深度不够）

现有：`users.memory` 一个字符串字段 + `remember/forget` 两个工具（`tools.ts`），每轮把整段
memory 拼进 system prompt（`runtime.ts:buildSystemPrompt`）。

成熟 Agent 的记忆：
- 结构化/分类型记忆（事实 / 偏好 / 情节 / 时间线）
- **语义检索（embedding/向量库）**，按相关性注入而非全量灌入 —— IClaw 无
- 自动抽取、去重、合并、遗忘曲线、consolidation —— 全无（PLAN.md 明确"不做全自动抽取"）
- 记忆可编辑/可审计 UI —— 目前只靠 `window.prompt` 编辑（`App.tsx`）

**风险**：memory 随使用无限增长，每轮全量注入 → 上下文快速膨胀 + 噪音干扰，与 token 感知压缩
（`transcript.ts`）形成矛盾。

---

## 3. 工具执行能力（工具很多，但不会"做事"）

- **没有代码/shell 执行工具**。技能是纯 `SKILL.md` 文本（`skills.ts`），`read_skill` 只把正文
  塞回上下文；Pi 编程版的 skill 依赖 bash/file 工具才能跑脚本，IClaw 里技能**无法真正执行命令**。
- 工具集很薄：`remember/forget/read_skill/web_fetch` + MCP（`tools.ts`）。缺 web search、
  浏览器自动化、文件读写、代码执行、日历/邮件等原生工具。
- **无沙箱**：MCP stdio 子进程继承**完整父进程环境变量**（`mcp.ts:createTransport`），密钥可被
  任意 MCP server 读到。
- **无工具级权限**：所有用户共享同一套工具，无"白名单/按用户配额/只读模式"。

---

## 4. 多模态与 I/O 体验

- **入站**：文本 + 图片（`monitor.ts` 只找 `findImageItem`），语音仅靠微信自带转写。
- **出站**：**只有纯文本**（`send.ts` 只有 `sendTextMessage`）。`getUploadUrl` 在 `api.ts` 里
  实现了但**没人调用** → 无法回图/回文件/回语音。
- **无流式**：`streamFn` 只用来跑，回复攒完一次性发（`bot.ts`），用户看不到打字过程（只有 typing 指示）。
- **无长消息分片**：超长回复不切片、不处理微信长度上限。
- **无富交互**：没有卡片/按钮/引用回复（引用只做入站解析）。

---

## 5. 平台工程化

| 维度 | 现状 | 成熟形态 |
|---|---|---|
| 扩展性 | 单进程 + `node:sqlite` + 内存 `Map<userId, Agent>` | 可水平扩展、队列化 |
| 并发控制 | 仅 per-user turn chain（`runtime.ts`），无全局限流/背压 | 队列、优先级、超时 |
| 幂等/重试 | 出站无重试/去重；turn chain 在内存，重启丢失 | 幂等键、持久队列 |
| 限流/配额 | 只有管理员登录限流（`app.ts`） | 按用户 token/次数配额 |
| 成本核算 | 无 token 计量、无费用统计 | 用量仪表盘/预算告警 |
| 模型 | **全局单一模型**，无 per-user/路由/降级 | 多模型路由、fallback、小模型分流 |
| 可观测性 | 只有日志（`logger.ts`），`redact.ts` 做脱敏 | metrics/trace/审计日志 |
| 会话 | 每用户**单会话**，`/new` 即清空 | 多会话/多线程、历史搜索、继续话题 |
| 多租户 | 共享工具 + 共享进程 | 隔离、RBAC |

---

## 6. 安全与合规

- **Prompt Injection 无防护**：微信任意文本进入带工具的 agent，出站无内容审核。
- **数据生命周期缺失**：无用户数据导出/删除、无保留策略、无同意记录（GDPR 类需求）。
- **密钥管理**：全局一个 `ICLAW_API_KEY`，无 per-user 凭证、无加密存储。
- **审计**：只有运行日志，没有"谁在何时让 agent 做了什么"的审计流水。
- 微信自动化本身的封号/合规风险（README 已自陈）。

---

## 7. 生态与用户体验

- **无自助 onboarding**：创建用户、绑定、发二维码全在管理员 Web 端，用户无法自助接入。
- **管理端偏"运维面板"**：没有对话历史查看、没有会话回放、没有用户级调试台。
- **技能无版本/无权限/无市场**：GitHub 安装很聪明，但缺版本管理、依赖声明、按用户启用。
- **无评测体系**：187 个单测都是**代码单测**，没有针对 agent 行为的 eval/回归集。

---

## 相对优势（别丢）

- 微信渠道提取 + 协议保真度高（`docs/extraction-notes.md`）
- 扫码即绑定、per-user 会话/人设/记忆隔离设计清晰
- token 感知压缩 + 硬上限兜底（`transcript.ts`）比多数 hobby 项目成熟
- skills/MCP 热加载、SSRF 防护的 `web_fetch`、管理员密码权威同步等细节到位
- 测试覆盖密度高

---

## 优先级总览

1. **记忆升级**（最能拉开差距）：向量检索 + 结构化记忆 + 自动抽取/去重。
2. **主动性**：定时任务/提醒 + 触发订阅。
3. **工具执行**：受沙箱约束的 bash/code 工具（激活现有 skills）+ web search。
4. **多模态出站**：复用 `getUploadUrl` 支持回图/回文件；长回复分片；流式打字。
5. **人格化隔离**：per-user 模型 + 配额 + 成本核算 + 出站幂等。
6. **安全**：MCP 环境变量白名单、工具权限、审计日志、数据删除/导出。
7. **自助接入 + 会话历史 UI**（产品化前置）。

详细可执行任务见 [`TODO.md`](./TODO.md)。
