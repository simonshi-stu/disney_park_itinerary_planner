# 项目 Agent 任务手册

本文档把当前业务决策、迁移阶段和最小 Agent 编排器串在一起，作为后续 Agent 的入口。它不是 API key 或聊天记录的存储位置。

## 已确认的业务边界

- 当前项目只覆盖 Disneyland Park 和 Disney California Adventure。
- 当前模型预测 Queue-Times 展示的 posted standby wait，不声称预测游客实际等待到登乘的时间。
- 默认训练对象是真正具有 standby wait 的项目。
- 人物见面只有在来源提供稳定 posted wait 时才加入；演出、巡游和娱乐项目进入 schedule constraint；没有排队能力的 walkthrough 不进入 standby wait 模型。
- 项目生命周期必须由官方 Disney 页面或官方 App 证据治理。refurbishment 保留历史数据，但不训练、不推荐；retired 保留历史但不训练、不推荐；unknown 进入审核。
- 当前保持约 15 分钟采集；预测 horizon 为 30、60、120 分钟，其中 120 分钟需要展示更大的不确定性。
- 最近 2–3 年作为热数据，更早 raw 数据转入对象存储冷归档。
- 规划器最终要支持 Lightning Lane、餐饮、休息、无障碍和预约，但必须先完成 posted wait baseline 和 API contract。

## 数据集判断

Hugging Face 的 `Disney-Theme-Park-Queue-Dynamics` 是一个有价值的外部研究数据集，但不能直接替代本项目数据：它的页面将项目描述为 Disney World Queue Dynamics，包含通用化项目名称、2018–2022 时间范围、15 分钟区间、`WAIT_TIME_MAX`、容量、停运和客流等运营字段。它没有本项目所需的 California Disneyland canonical identity、官方生命周期证据、Queue-Times raw lineage 和当前两园区 scope。

可以把它用于：

- 外部 baseline 和特征工程参考。
- 研究停运、容量和等待动态的建模方法。
- 构造离线实验或模拟数据。

不能把它未经 provenance、park identity 和字段语义验证就合并到生产训练集。

## 受控编排器

入口代码：`tools/agent-orchestrator.mjs`

总任务清单：`tasks/manifests/project-migration.v1.json`

唯一进度来源：`tasks/status/project-migration-status.v1.json`。README 和模块文档不复制易变化的阶段状态。

查看阶段：

```powershell
npm.cmd run agent:plan
```

只生成 DeepSeek prompt，不产生 API 请求：

```powershell
npm.cmd run agent:run -- --phase=01-data-contracts --dry-run
```

执行一个 DeepSeek worker 阶段：

```powershell
$env:DEEPSEEK_API_KEY = "在本地临时设置的新 key"
$env:DEEPSEEK_MODEL = "你的账户可用模型"
npm.cmd run agent:run -- --phase=01-data-contracts
```

默认最多调用 DeepSeek 两次：第一次 patch 未满足 required outputs、allowlist 或文件一致性时，Controller 会把错误自动反馈给 Worker。可以显式设置 1–3 次：

```powershell
npm.cmd run agent:run -- --phase=01-data-contracts --attempts=2
```

结果会写入被 git 忽略的 `.agent-runs/<phase>-<timestamp>/`：

```text
worker-prompt.md
worker-response.json
worker-result.json
controller-validation.json
worker.patch
review-prompt.md
```

每次尝试还会保存 `worker-response-attempt-N.json` 和 `controller-validation-attempt-N.json`。编排器默认不会自动应用 patch；结构校验通过后仍要由 GPT/Codex 审查业务语义，在隔离分支中应用并运行测试。

Codex 审查只填写 `controller-review-template.json` 中的错误类型、证据、正确实现逻辑和修改顺序，不直接编写业务 patch。保存为 `controller-review.json` 后运行：

```powershell
npm.cmd run agent:revise -- .agent-runs/<run-directory> --review-file=.agent-runs/<run-directory>/controller-review.json --attempts=2
```

新 revision 会生成独立目录并保留 parent run。每个 `run-report.md` 都记录改动、问题原因、解决逻辑以及本次 run 是否完成。

## 上下文如何上传给 DeepSeek

不要直接上传整个仓库的所有文件。真正有助于理解架构的是：

- 根目录 `AGENTS.md`、context map 和 contracts 导航。
- 当前 phase 的 `required_reads` 中明确列出的架构文档、ADR 和数据文档。
- `packages/contracts/` 中的 schema 和 README。
- 当前 phase `allowed_paths` 内的源码、测试和模块 README。

`agent-orchestrator.mjs` 会自动生成 context pack。原子任务不默认上传全部 architecture/ADR；manifest 必须把真正相关的文件写入 `required_reads`：

```text
context-index.json
context-pack.md
```

默认 phase 模式只发送当前阶段需要的上下文；如果需要架构级全局审查，可以运行：

```powershell
npm.cmd run agent:run -- --phase=01-data-contracts --context=full --dry-run
```

即使使用 `full`，也会排除 `data/`、`outputs/`、`src/cache/`、`node_modules/`、`.agent-runs/`、`.env`、锁文件和密钥。历史 CSV 不是理解项目 contract 所必需的，不应直接上传给编码模型。

如果 context index 显示文件被 `total_context_limit` 省略，优先增加 `AGENT_CONTEXT_MAX_CHARS`，或缩小 phase 范围；不要盲目把生产历史数据加入 prompt。

## GPT 如何审查 DeepSeek

### 推荐：直接使用 Codex

当前不需要 GPT API。运行 worker 后，把对应的 `review-prompt.md` 提供给 Codex，并要求：

```text
请严格按 review-prompt.md 返回 JSON，只检查该 phase 的 allowlist、contract、测试、数据不变量和回滚风险。不要自行扩大修改范围。
```

Codex 适合当前阶段，因为它已经能读取工作区和项目 Skill。用户只需要把 `review-prompt.md` 指向当前对话，不必额外支付一个 OpenAI API 调用。

### 可选：OpenAI API 自动审查

如果将来要让 GitHub Actions 全自动审查，可以配置：

```powershell
$env:OPENAI_API_KEY = "本地或 CI secret"
$env:OPENAI_MODEL = "账户可用的审查模型"
npm.cmd run agent:run -- --phase=01-data-contracts --review=openai
```

这条路径不是当前必需项。它会增加 API 成本和 secret 管理复杂度，应该在手动 Codex 流程稳定后再启用。

## 安全规则

- 任何 `sk-...` key 一旦出现在聊天、日志或仓库中，应立即撤销并重新生成。
- key 只通过环境变量、GitHub Secrets 或云端 secret manager 提供。
- 不把 raw 数据、用户数据、Cookie 或生产连接字符串发送给模型。
- worker 只能返回 patch，不能直接 push `main` 或 merge PR。
- `.agent-runs/` 不应提交；其中可能包含模型响应和上下文摘要。
- 生产数据库初始化、云账单、首次数据切换、停止 Git collector 和 raw retention 变更必须人工 gate。

## 运行顺序

```text
GPT 定义任务
  -> manifest 锁定范围
  -> DeepSeek 生成 patch
  -> deterministic CI
  -> GPT/Codex 审查
  -> accepted / revise / blocked / human_gate
  -> 隔离分支 PR
  -> staging 自动部署
  -> 首次生产切换人工确认
```

每个阶段最多自动返工 2–3 次。超过限制后必须保留日志并进入 blocked，而不是无限消耗 API token。

Phase 2 为避免 DeepSeek 的 JSON/unified diff 超过单次输出容量，拆成按顺序执行的原子阶段：`02a1-migration-runner`、`02a2a-storage-schema`、`02a2b-storage-schema-test-v2`、`02a3-storage-integration`、`02b1-restore-verifier`、`02b2-restore-runbook`。全部完成才代表 storage foundation 完成；云资源创建、生产 secret 和首次 hosted restore 仍需人工操作。若 Worker 声称修改多个文件但 patch 被截断，Controller 必须拒绝该 run 并继续缩小任务，不得拼接不完整 patch。
