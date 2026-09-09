# Agent 任务清单

任务 manifest 是 Agent 的可执行需求合同，不是聊天记录。每个阶段必须声明：目标、允许修改的路径、必须阅读的上下文、验收条件、命令和人工 gate。

当前迁移总清单：

```text
tasks/manifests/project-migration.v1.json
```

先运行 `npm.cmd run agent:plan` 查看阶段，再只运行一个 phase。DeepSeek worker 默认返回 patch 和报告；GPT/Codex 审查通过后，才由人工或受保护的 PR 流程应用 patch。
