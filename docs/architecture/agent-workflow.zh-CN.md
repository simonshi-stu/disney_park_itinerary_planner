# Agent 编码与验收架构

## 边界

本文件只描述 Agent 系统架构。业务需求属于数据/模块文档；阶段目标属于 task manifest；命令教程属于 `docs/agent-task-handbook.zh-CN.md`。

## 角色

### GPT/Codex Controller

Controller 是唯一决策者，负责把已确认的业务规则写入 manifest，选择上下文，审查 Worker patch，运行确定性检查，并输出：

```text
accepted | revise | blocked | human_gate
```

Controller 不编写或重写业务代码。它只读取 diff、Controller validation、直接受影响的 contract/test，分类错误、引用证据并说明正确实现逻辑。Controller 不把模糊问题交给 Worker 猜测，也不因为 Worker 声称测试通过就跳过本地验证。

### DeepSeek Worker

Worker 只在一个 phase 的 allowlist 中编码。输入包含项目规则、架构、ADR、contracts、当前源码、测试、已决定事项和 required outputs。输出必须是结构化 JSON 与完整 unified diff；`files_changed` 必须和 diff 完全一致。

Worker 不拥有 merge、生产凭证、云账单、数据删除或生产切换权限。

### Deterministic Controller

编排器在语义审查前自动验证：

- patch 非空。
- `files_changed` 与 diff 文件一致。
- required outputs 全部存在。
- 所有路径位于 allowlist。
- secret-like 内容和敏感路径未进入上下文。

结构校验失败时，编排器把具体错误反馈给 DeepSeek，最多重试三次。结构通过不代表业务正确，仍必须由 Codex 审查。语义审查失败后，Codex 写入 `controller-review.json`，`agent:revise` 把错误证据和正确逻辑交给 DeepSeek；Codex 不代写修复。

## 上下文分层

默认 `phase` 模式发送：

1. 根 `AGENTS.md` 与中文 context map。
2. contracts 导航 README。
3. 当前 phase 明确列出的 `required_reads`，包括需要的架构文档、ADR、schema 和模块 README。
4. 当前 phase allowlist 内的源码和测试。

不要把全部 `docs/architecture/` 和 `docs/adr/` 默认发送给每一个原子编码任务。阶段必须通过 `required_reads` 精确声明所依赖的决策；这样既保留必要业务上下文，也避免单文件任务携带数万字符的无关历史。

`full` 模式用于全局架构审计，并受字符上限约束。两种模式都排除 `data/`、`outputs/`、cache、依赖、`.env`、`.agent-runs/` 和生成历史。数据问题通过 schema、质量摘要与小 fixture 表达，不上传生产 CSV。

每次 context pack 记录文件路径、SHA-256、原始/包含字符数、截断和省略原因，避免依赖聊天记忆。

## 状态机

```text
planned
  -> context_locked
  -> worker_attempt_1
  -> controller_validation
       -> revise -> worker_attempt_2/3
       -> ready_for_codex_review
  -> deterministic_tests
  -> codex_review
       -> accepted -> checkpoint
       -> revise -> 新 revision task
       -> blocked -> 用户补充不可推断的信息
       -> human_gate -> 等待生产/账单/权限批准
```

## 允许自动化与人工 gate

可以自动执行：context 打包、Worker 调用、patch 结构验证、测试、staging 部署和可逆健康检查。

必须人工确认：创建付费资源、生产 secret/OIDC trust、首次生产数据库初始化与切换、停止 Git 数据采集、删除或缩短 raw retention、扩大用户隐私数据范围。

## 合并策略

Worker 不直接修改 `main`。每个 phase 对应一个小型分支/PR；required checks、Codex review 和 staging 健康检查通过后才可合并。首次生产切换保留人工批准。
