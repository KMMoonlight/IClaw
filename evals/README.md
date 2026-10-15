# Evals

Agent 行为回归集，独立于单元测试，面向"用户可感知的行为"。

## 运行

```bash
npm run eval                 # 确定性用例（无需模型，CI 默认跑这个）
ICLAW_EVAL_LIVE=1 npm run eval   # 追加实模型端到端用例（需配置 ICLAW_MODEL* / ICLAW_API_KEY）
```

失败时进程退出码为 1，可直接用于 CI。CI（`.github/workflows/ci.yml`）在 `npm test` 之后运行 `npm run eval`。

## 用例分类

- **memory**：相关性检索命中、抽取去重、合并去重、prompt 段落有界。
- **tools**：按用户禁用工具、危险工具审批挂起。
- **safety**：安全准则注入、外部内容标记、出站审核放行。
- **sessions**：活动会话切换。
- **live**（需 `ICLAW_EVAL_LIVE=1`）：端到端回复非空、token 用量被记录。

## 添加用例

在 `src/eval/suite.ts` 的 `deterministicCases()` 里追加：

```ts
{
  group: "memory",
  name: "描述这个行为",
  run: async () => {
    // 断言；抛错即视为失败
  },
}
```

实模型用例加到 `src/eval/live.ts`。
