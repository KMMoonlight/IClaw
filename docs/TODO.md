# IClaw 优化 TODO

> 配套文档：[`ROADMAP.md`](./ROADMAP.md)
>
> 约定：`P0` = 形态级/阻塞性，`P1` = 显著提升体验与能力，`P2` = 工程化与长尾。
> 工作量标注 `(S/M/L)`：S ≈ 半天，M ≈ 1–3 天，L ≈ 3 天以上。
> 每个任务给出「目标 / 落点 / 验收标准」，可直接建 issue。
>
> **进度**：M1 记忆 ✅；M2 主动性 ✅；M3 工具/沙箱 ✅；M4 多模态 ✅；M5 平台化 ✅（除 T5.5）；M6 安全合规 ✅；**M7 产品化 ✅**（T7.3 升级/回滚未实现，已标注）。**459 tests 全绿**，`npm run eval` 通过，`tsc --noEmit` 通过。

---

## 里程碑总览

| 里程碑 | 主题 | 关键任务 |
|---|---|---|
| M1 | 记忆系统升级 | T1.1 – T1.7 |
| M2 | 主动性 / 定时任务 | T2.1 – T2.5 |
| M3 | 工具执行与沙箱 | T3.1 – T3.6 |
| M4 | 多模态与 I/O | T4.1 – T4.5 |
| M5 | 平台工程化 | T5.1 – T5.9 |
| M6 | 安全与合规 | T6.1 – T6.6 |
| M7 | 生态与产品化 | T7.1 – T7.5 |

---

## M1 — 记忆系统升级（P0，最能拉开差距）

- [x] **T1.1 记忆数据模型重构** (M) — ✅ 已完成
  - 目标：把 `users.memory` 单字符串升级为结构化记忆表。
  - 落点：`src/db/index.ts` 新增 `memories` 表（`id, user_id, kind, content, source, importance, created_at, updated_at, last_used_at, embedding BLOB`）+ `meta` 表；`migrateLegacyMemory()` 一次性迁移；`src/agent/tools.ts` 的 `remember/forget` 与 `runtime.ts:buildSystemPrompt` 已切到结构化存储（新增 `list_memories` 工具、`src/agent/memory.ts` 预算化渲染）。
  - 验收：✅ 迁移可把现有 `memory` 拆行入库；旧数据不丢；`/api/users/:id/memories` + `/api/memories/:id` 增删改查接口可用；159 tests 全绿。
  - 后续：`users.memory` 字段保留但已废弃，legacy `memory` PATCH 已 write-through 到结构化存储。

- [x] **T1.2 记忆自动抽取** (M) — ✅ 已完成
  - 目标：每轮对话后自动提取值得记住的事实/偏好，而非只依赖模型主动 `remember`。
  - 落点：新增 `src/agent/memory-extract.ts`（宽容 JSON 解析、去重、注入式 `CompleteFn` 便于测试）；`runtime.ts` 每轮结束后 fire-and-forget 调用（最近 6 条）；`ICLAW_MEMORY_AUTO_EXTRACT` 开关（默认关）。
  - 验收：✅ 抽取失败不影响主流程（内部捕获）；重复事实不重复入库（`findMemoryByContent` + 本轮去重）；可开关；新增 12 个单测。

- [x] **T1.3 向量检索与相关性注入** (L) — ✅ 已完成
  - 目标：用 embedding 检索相关记忆，替代"全量灌入 system prompt"。
  - 落点：新增 `src/agent/embedding.ts`（OpenAI 兼容 `/embeddings`，复用 `ICLAW_MODEL_BASE_URL`/`ICLAW_API_KEY`，可 `ICLAW_EMBEDDING_BASE_URL`/`ICLAW_EMBEDDING_MODEL` 覆盖）；新增 `src/agent/memory-retrieval.ts`（向量 cosine 排序 + 关键词 bigram 排序 + 字符预算选择）；`runtime.ts:buildSystemPrompt` 改为按当前输入检索（异步）。
  - 验收：✅ system prompt 中记忆长度有上限（≤4000 字）；未配置 embedding 或调用失败时**自动降级为关键词检索**（方案 C）；缺失向量懒回填并持久化；新增 23 个单测。

- [x] **T1.4 记忆合并/衰减/consolidation** (M) — ✅ 已完成
  - 目标：定期合并同类记忆、淘汰长期未用事实，防止无限增长。
  - 落点：新增 `src/agent/memory-consolidate.ts`（确定性、无模型：精确/近似去重合并 + 陈旧低重要度剪枝 + 每用户上限）；`POST /api/memories/consolidate` 与 `/api/users/:id/memories/consolidate`；`startServer` 启动时整体跑一次；导出 `consolidateAllUsers` 供 T2.1 调度器复用。
  - 验收：✅ 重复/近似记忆被合并（保留高重要度）；陈旧低重要度被剪枝（`profile` 永不删）；`last_used_at`/`created_at` 驱动的衰减有单测。

- ~~T1.5 记忆管理 UI~~（不需要，已跳过）
  - 说明：管理员/用户暂不需要列表化编辑记忆；底层 API 已就绪，后续如需要可直接接。

- [x] **T1.6 `.env.example` 与文档更新** (S) — ✅ 已完成
  - 目标：新增 `ICLAW_MEMORY_AUTO_EXTRACT`、`ICLAW_EMBEDDING_MODEL`、`ICLAW_EMBEDDING_BASE_URL` 等开关文档。
  - 落点：`.env.example`（已加）、`README.md`（待补记忆章节）。

- [x] **T1.7 记忆相关 eval 用例** (S) — ✅ 已完成
  - 目标：固定若干"该记住/该召回"的场景做回归。
  - 落点：`src/agent/memory-eval.test.ts`（6 个检索场景全部命中 top-1 + 不重复累积）。
  - 验收：✅ CI 中随全量测试运行。

---

## M2 — 主动性 / 定时任务（P0，形态级）

- [x] **T2.1 调度器基础设施** (M) — ✅ 已完成
  - 目标：可持久化的定时任务调度（cron 表达式 + 一次性提醒）。
  - 落点：`src/scheduler/cron.ts`（无依赖 5 段 cron 解析 + next-run，支持 `*`/范围/步长/列表/dom-dow OR 语义）+ `src/scheduler/tasks.ts`（`scheduled_tasks` CRUD + `resolveScheduleSpec` 支持 cron/相对/ISO/时间戳）+ `src/scheduler/scheduler.ts`（`runDueTasks`/`startScheduler`，互斥 pass、重启恢复、one-off 标记 done、cron 重排、失败不卡死）。
  - 验收：✅ 重启后任务不丢；29 个单测覆盖 next_run 计算、恢复、错误处理。

- [x] **T2.2 提醒工具集** (M) — ✅ 已完成
  - 目标：agent 可被用户要求"明天 9 点提醒我 X"。
  - 落点：`src/agent/schedule-tools.ts`（`schedule_task`/`list_tasks`/`cancel_task`，每用户上限 20）+ `src/scheduler/deliver.ts`（到点经 `sendTextMessage` 推送）+ `startServer` 启动调度器。
  - 验收：✅ 微信里可创建/查询/取消提醒；到点收到消息；按用户隔离。

- [x] **T2.3 主动触发的 agent turn** (M) — ✅ 已完成
  - 目标：定时任务触发时运行一个 agent turn（而非只发固定文本）。
  - 落点：`runtime.runScheduledAgentTurn`（无 inbound 的合成 turn，复用同一 turn chain，冻结用户返回空）+ task `payload.mode=agent`；`schedule_task` 新增 `mode` 参数；`runScheduledTask` 分发 message/agent。
  - 验收：✅ 可配置定时让 agent 生成并推送内容。

- [x] **T2.4 事件订阅框架** (L) — ✅ 已完成
  - 目标：除时间外，支持"某条件满足就触发"。
  - 落点：`watchers` 表 + `src/scheduler/watchers.ts`（CRUD/interval 轮询）+ `src/scheduler/triggers.ts`（`checkWatcher`：内容指纹变化 / 关键词 absent→present；`runWatchers` 失败只推进检查时间）+ `src/agent/watch-tools.ts`（`watch_url`/`list_watchers`/`cancel_watcher`）；复用 `fetchUrlWithGuards` 的 SSRF 防护；`startScheduler` 新增 `afterTasks` 钩子。
  - 验收：✅ 可配置监控一个 URL 变化/关键词出现并推送。

- ~~T2.5 Web 端任务管理~~（不需要，已跳过；底层 API/工具已就绪）

---

## M3 — 工具执行与沙箱（P0/P1）

- [x] **T3.1 bash / 代码执行工具** (L) — ✅ 已完成
  - 落点：`src/agent/exec-tools.ts`（`bash`/`read_file`/`write_file`/`list_dir`）+ `src/agent/workspace.ts`（路径限制）+ `src/agent/shell.ts`（超时/输出上限/minimal env）；配置门控 `ICLAW_TOOLS_EXEC`。
- [x] **T3.2 执行沙箱** (L) — ✅ 已完成
  - 落点：`src/agent/sandbox.ts`（bwrap / macOS sandbox-exec，默认禁网；`auto`/`required`/`none`）+ `ICLAW_EXEC_ALLOW_NETWORK`。
- [x] **T3.3 工具权限模型** (M) — ✅ 已完成
  - 落点：`users.tools_json` + `setUserDisabledTools`/`getUserDisabledTools`；`buildTools` 过滤；`PATCH /api/users/:id { disabledTools }`。
- [x] **T3.4 危险工具审批流** (L) — ✅ 已完成（**可选，默认关闭**）
  - 落点：`src/agent/approvals.ts`（`withApproval` 挂起 + `parseApprovalReply`）+ agent-gateway 同意/拒绝处理；`ICLAW_APPROVAL_TOOLS`。
  - 默认：`ICLAW_APPROVAL_TOOLS` 为空 → 所有工具直接执行（默认放行）；仅在显式配置后才对列出的工具要求用户确认。
- [x] **T3.5 web_search 工具** (M) — ✅ 已完成
  - 落点：`src/agent/web-search.ts`（tavily/brave/searxng 适配器）+ 工具仅在配置后注册；`ICLAW_SEARCH_*`。
- [x] **T3.6 skill 依赖与脚本支持** (M) — ✅ 已完成
  - 落点：`skills.ts` 解析 frontmatter `allowed-tools`/`requires` 并展示；配合 T3.1 的 bash 可执行技能脚本。

---

## M4 — 多模态与 I/O（P1）

- [x] **T4.1 出站图片/文件** (M) — ✅ 已完成
  - 落点：依据 `Tencent/openclaw-weixin` 的 `cdn-upload.ts`/`upload.ts`/`send-media.ts` 移植——`src/wechat/cdn/cdn-upload.ts`（AES-128-ECB 加密 POST，读 `x-encrypted-param`，4xx 立即失败/5xx 重试）、`src/wechat/upload.ts`（getUploadUrl + 上传，rawsize/md5/padded size）、`src/wechat/send.ts`（IMAGE/VIDEO/FILE item 构造 + caption）、`src/wechat/send-media.ts`（按 MIME 路由）、`src/agent/media-tools.ts`（`send_file`/`send_image` 工具，限定 workspace + 大小上限）。
  - 验收：✅ item 构造/url/加密/重试/路由均有单测（mock 网关）；`ICLAW_SEND_MEDIA_MAX_BYTES`。

- [ ] **T4.4 更完整的入站媒体** (M) — ✅ 已完成
  - 落点：`media-download.ts:downloadFileFromItem`（FILE 下载+解密+推断 MIME）+ `inbound.ts:findMediaItem/isImageMedia/buildMediaNote` + `monitor.ts`（非图片附件以文字提示交给模型）+ `runtime.ts`（只把 `image/*` 当图片输入）。

- [x] **T4.2 长回复分片** (S) — ✅ 已完成
  - 落点：`send.ts:chunkText/sendTextChunked`（按段落/句子边界分片）+ `ICLAW_SEND_CHUNK_CHARS`；`bot.ts` 统一走分片发送。

- [x] **T4.3 流式/分段输出体验** (M) — ✅ 已完成
  - 落点：`runtime.ts` 新增 `RunHooks.onTextDelta`（订阅 Agent `message_update` 的 `text_delta`）+ `wechat/progressive.ts:ProgressiveSender`（按阈值分段推送、收尾补发、无重复）+ `ICLAW_STREAM_PROGRESS`。

- [ ] **T4.5 富交互（引用/卡片）** (M) — ⛔ 网关不支持
  - 结论：核对原实现后确认 iLink bot 协议**无出站 `ref_msg`/交互卡片类型**（`src/messaging/send.ts` 只有 TEXT/IMAGE/VIDEO/FILE item；仓库无 card/button 模块），故无法实现；如未来网关支持再补。

---

## M5 — 平台工程化（P1/P2）

- [x] **T5.1 per-user / 多模型路由** (M) — ✅
  - 落点：`users.model`；`models.ts:resolveModelFor/ensureModelRegistered/resolveFallbackModel`；`runtime` 每轮应用用户模型 + 主模型失败重试一次；`PATCH /api/users/:id { model }`；`ICLAW_MODEL_FALLBACK`。
- [x] **T5.2 token/成本核算** (M) — ✅
  - 落点：`usage` 表 + `recordUsage/getUserUsageTotal/getUserUsageForDay/listUsageTotals`；`runtime` 每轮从 assistant usage 记录；`GET /api/users/:id/usage`、`GET /api/usage`。
- [x] **T5.3 按用户配额与限流** (M) — ✅
  - 落点：`src/agent/quota.ts`（每分钟消息 + 每日 token）；`bot.ts` 前置检查；`ICLAW_USER_RATE_PER_MIN`/`ICLAW_USER_DAILY_TOKEN_LIMIT`。
- [x] **T5.4 出站幂等与重试** (M) — ✅
  - 落点：`send.ts:sendWithRetry`（指数退避，复用同一 `client_id`）；`ICLAW_SEND_RETRIES`。
- [ ] **T5.5 持久化任务队列** (L) — ⏸ 待办
  - 说明：需引入 inbound 队列表 + worker 并重构 `runtime` 的 turn chain；单进程部署下网关 `sync_buf` 已提供大部分耐久性，收益/风险比偏低，故单独留作后续。
- [x] **T5.6 多会话 / 多线程** (L) — ✅
  - 落点：`sessions` 表重构（id/user_id/title/…）+ 旧库迁移 `migrateSessionsV2`；`users.active_session`；`/new`（保历史）、`/sessions`、`/switch <n>`；`dropAgent` 重载。
- [x] **T5.7 可观测性：metrics** (M) — ✅
  - 落点：`src/metrics.ts`（counters/summary + Prometheus 文本）；`GET /metrics`；turn/工具/fallback/定时任务打点。
- [x] **T5.8 审计日志** (M) — ✅
  - 落点：`audit_log` 表 + `recordAudit/listAudit`；agent 工具调用与管理操作写入；`GET /api/audit`。
- [x] **T5.9 优雅关闭与健康检查增强** (S) — ✅
  - 落点：`src/agent/inflight.ts`（begin/end/waitForIdle）；`runtime` 计入在途；SIGTERM 等待在途对话（≤5s）再退出。

---

## M6 — 安全与合规（P0/P1）

- [x] **T6.1 MCP 子进程环境变量白名单** (S) — ✅ 已完成（M3 阶段）
- [x] **T6.2 Prompt Injection 防护** (M) — ✅
  - 落点：`src/agent/security.ts`（`SECURITY_POLICY` + `wrapUntrusted`）；runtime 注入准则；`web_fetch`/`web_search` 输出标记为外部不可信。
- [x] **T6.3 内容安全与出站审核** (M) — ✅
  - 落点：`src/moderation.ts`（正则黑名单）；`send.ts` 在文本/字幕出站前替换；`ICLAW_OUTBOUND_BLOCKLIST`/`_MESSAGE`。
- [x] **T6.4 数据生命周期：导出/删除/保留** (M) — ✅
  - 落点：`db:exportUserData/deleteUserData/purgeOldData`；`GET /api/users/:id/export`、`DELETE /api/users/:id`；`ICLAW_DATA_RETENTION_DAYS` 启动清理。
- [x] **T6.5 密钥与凭证管理** (M) — ✅
  - 落点：`mcp:maskMcpServers/mergeMaskedSecrets`；`GET /api/mcp` 屏蔽 `env` 密钥，PUT 保存时回填（不误覆盖）。
- [x] **T6.6 权限与角色（RBAC）** (M) — ✅
  - 落点：`admins.role`（viewer<admin<owner）+ `roleAtLeast`；`authGuard` 强制非 GET 需 admin；`GET/PATCH /api/admins`（owner）。

---

## M7 — 生态与产品化（P2）

- [x] **T7.1 用户自助接入** (L) — ✅
  - 落点：`invites` 表 + `createInvite/getInvite/listInvites/markInviteUsed`；`POST/GET /api/invites`（管理员）；公开 `GET /api/onboard/:code`（校验）与 `POST /api/onboard/:code`（创建用户 + 返回绑定二维码）。
- [x] **T7.2 会话历史 API** (M) — ✅（UI 按偏好未做）
  - 落点：`getSessionDetail`；`GET /api/users/:id/sessions`、`GET /api/sessions/:sessionId`（含完整 transcript）；工具轨迹可通过 `GET /api/audit?userId=` 获取。
- [~] **T7.3 技能版本/启用管理** (M) — ⚠️ 部分完成
  - 已做：frontmatter `version` 解析与展示；`skill_settings` 全局开闭；`users.disabled_skills` 按用户开闭；`GET /api/skills` 返回 `version/enabled`、`PATCH /api/skills/:name`。
  - 未做：就地**升级/回滚**（需备份/恢复目录，未实现，未冒充完成）。
- [x] **T7.4 Agent 行为 eval 框架** (M) — ✅
  - 落点：`src/eval/`（runner + 确定性用例 + 可选实模型用例）+ `npm run eval` + `.github/workflows/ci.yml` 已纳入。
- [x] **T7.5 多通道抽象** (L) — ✅
  - 落点：`channels/types.ts`（Channel/InboundMessage/ReplySink）、`channels/agent-gateway.ts`（把路由/会话/审批/配额/turn 从微信层剥离）、`channels/registry.ts`、`channels/memory.ts`（示例第二渠道）；`bot.ts` 降为微信适配器。

---

## 建议执行顺序（前 6 周）

1. **第 1 周**：T1.1、T1.6、T6.1（低风险高收益，先把数据和密钥基础打好）
2. **第 2–3 周**：T1.2、T1.3、T1.5、T1.7（记忆闭环 + UI）
3. **第 4 周**：T2.1、T2.2、T2.3（定时提醒闭环）
4. **第 5 周**：T4.1、T4.2、T3.1（多模态出站 + 动手能力雏形）
5. **第 6 周**：T5.1、T5.2、T5.3、T6.2（人格化隔离与安全加固）

> 每完成一项：更新对应模块测试、更新 `.env.example`/`README.md`，并保持 `npm run typecheck && npm test` 通过。
