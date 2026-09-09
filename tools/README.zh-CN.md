# Agent 编排器工具

本目录只拥有编排器实现。业务决策和操作说明分别位于：

- `tasks/manifests/project-migration.v1.json`：机器可读任务合同。
- `docs/agent-task-handbook.zh-CN.md`：用户操作手册。
- `docs/architecture/agent-workflow.zh-CN.md`：Controller/Worker 架构与安全边界。

常用命令：

```powershell
npm.cmd run agent:plan
npm.cmd run agent:run -- --phase=01-data-contracts --dry-run
npm.cmd run agent:run -- --phase=01-data-contracts --attempts=2
npm.cmd run agent:revise -- .agent-runs/<run-directory> --review-file=.agent-runs/<run-directory>/controller-review.json --attempts=2
```

默认 `phase` 上下文包含全局规则、架构、ADR、contracts，以及当前 phase allowlist 内的源码和测试。只有架构审计才使用 `--context=full`。

真实 key 只写入被 git 忽略的根目录 `.env`：

```env
DEEPSEEK_API_KEY=replace-with-a-new-key
DEEPSEEK_MODEL=deepseek-chat
```

每次运行在 `.agent-runs/` 生成 context、Worker 结果、Controller 校验、review template 和 run report。Codex 只填写错误分类与正确实现逻辑，不写替代代码；`agent:revise` 将反馈交回 DeepSeek。Worker patch 不会被自动应用，只有结构校验、Codex 语义审查和测试都通过后才允许落地。
