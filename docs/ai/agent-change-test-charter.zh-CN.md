# Agent 修改准则与测试准则

> 定位：所有编码 agent（DeepSeek Worker 与任何执行者）的操作性准则。业务规则见根 `AGENTS.md`；编排与安全边界见 `docs/architecture/agent-workflow.zh-CN.md`；任务合同见 `tasks/manifests/project-migration.v1.json`。
>
> 冲突优先级：`AGENTS.md` > 本文件 > 模块 README。可执行行为与文档冲突时必须上报，不得静默选择。
>
> 本文件由 Controller（Codex）维护；Worker 无权修改本文件。

## 1. 修改边界（只改 manifest 允许的）

1. 唯一允许修改的文件 = 当前 phase 在 manifest 中声明的 `allowed_paths`（精确文件或目录前缀）。除此之外全部只读。
2. 全项目只读/禁止修改清单（任何 phase 都不例外）：
   - 生成数据与派生物：`data/`、`outputs/`、`src/cache/`、`latest_snapshot.json`。
   - 受保护 bootstrap 脚本：`scripts/collect-wait-times.mjs`、`scripts/analyze-wait-times.mjs`、`scripts/update-cache.mjs`（ADR-0004；除非新 ADR 明确变更）。
   - 已应用的迁移：`infra/migrations/0001_observation_storage.sql`；`0002` 应用后同样不可改。新需求 = 新增 additive migration。
   - 凭据与环境：`.env`、`.env.local`、任何 secret、连接字符串。
   - 工具残留与缓存：`node_modules/`、`.agent-runs/`、`work/`、`.tmp_doc_review/`。
3. 需要的修改超出 `allowed_paths` → 停止并上报 `blocked` 或 `questions`，绝不悄悄扩大范围。
4. 禁止：无关清理、全仓格式化、顺手重构、把生成数据刷新混进代码改动、把易变进度复制到多个 README。

## 2. 工作区域（改动如何分组与落地）

1. 一个 phase = 一个原子变更集 = 一个分支/PR；不跨 phase 混改。
2. 同一文件被多个 phase 需要（如 `package.json`）时，只归入其中一个 phase，另一个 phase 在 `decisions` 中声明「不再修改该文件」。
3. 改动前必读：根 `AGENTS.md`、`docs/ai/context-map.zh-CN.md`、本文件、所属模块 `README.zh-CN.md`、直接受影响的 contract 与测试。
4. 改动后：公共接口/不变量变化更新所属模块 README；架构决策新增 ADR；跨模块形状先改 `packages/contracts`。
5. 提交信息：`<type>(<scope>): <summary>`；数据刷新与代码改动必须分开提交。

## 3. 测试准则（只测本 phase 改变的行为）

必须写测试的情形（每种一条聚焦断言，不铺矩阵）：
- 本 phase 新增或修改的每一条业务规则/公共行为。
- 本 phase 涉及的失败/降级路径（来源失败、closed/zero、缺失值、无解）。
- 规则：`node:test` + `node:assert`；小型 fixtures（不复制生产历史）；注入 fake client/clock；测试不需要 live DB、网络或真实 API。

禁止的过度测试（避免重复与过度保护）：
- 不重复已有表征测试或既有测试已锁定的行为，除非本 phase 明确改变该行为。
- 不写脆弱的全文件快照断言；不测第三方库功能。
- 不为「以防万一」增加与验收无关的额外测试层。
- 不把生产 CSV/JSON 历史搬进 fixtures。

验收口径：`npm run check` 通过 + 本 phase `commands` 通过；diff 只含本 phase 文件；无凭据/生成物。
若在受限沙箱中 `node --test` 因 `spawn EPERM` 失败，如实报告环境限制，不得为了绕过而改写测试或跳过验证。

## 4. 当前三步工作的具体边界

### 步骤 1：把未提交的 Phase 1/2 工作分组提交

- 允许操作：仅 `git add`/`git commit`，**不修改任何文件内容**。
- 分组（按顺序，5 个提交）：

  1. `chore(agents): orchestrator, task manifest and workflow docs`
     `tools/`、`tasks/`、`tests/agent-orchestrator/`、`docs/architecture/agent-workflow.zh-CN.md`、`docs/agent-task-handbook.zh-CN.md`、`docs/ai/agent-change-test-charter.zh-CN.md`、`.env.example`、`.gitignore`、`.agents/`、`package.json`（跨阶段的 npm scripts 集中在本提交一次性落地，历史中短暂的不一致性可接受）。
  2. `feat(contracts): catalog lifecycle and wait-time audit contracts`
     `packages/contracts/schemas/v1/catalog-attraction-lifecycle.schema.json`、`packages/contracts/schemas/v1/wait-time-history-audit.schema.json`、`packages/contracts/README.zh-CN.md`、`modules/catalog/README.zh-CN.md`、`tests/catalog/`、`docs/adr/0007-posted-wait-and-operational-lifecycle.md`、`docs/data/data-dictionary.zh-CN.md`、`docs/data/data-governance.zh-CN.md`、`docs/data/forecast-readiness.zh-CN.md`、`docs/v0.5-data-quality.md`、`docs/ai/context-map.zh-CN.md`。
  3. `feat(observations): target normalization and history audit`
     `modules/observations/`（index.mjs、internal/、repository-history-adapter.mjs、README.zh-CN.md）、`scripts/audit-wait-time-history.mjs`、`tests/observations/`。
  4. `feat(infra): migration runner, lifecycle schema, backfill and restore verifier`
     `infra/migrations/run-migrations.mjs`、`infra/migrations/0002_catalog_lifecycle_and_indexes.sql`、`infra/backfill/`、`infra/restore/`、`scripts/backfill-wait-times-to-postgres.mjs`、`tests/storage/`、`infra/README.zh-CN.md`、`docs/data/migration-runbook.zh-CN.md`、`docs/data/storage-backup-restore.zh-CN.md`。
  5. `docs: add human-readable progress report`
     `docs/progress-report.zh-CN.md`。

- 绝不提交：`.env`、`.agent-runs/`、`work/`、`node_modules/`。
- 测试范围：本步骤不改代码 → 不新增测试；提交前只跑一次 `npm run check` 确认基线（本机或 CI）。

### 步骤 2：manifest 追加 03–08 子阶段

- 允许操作：只改 `tasks/manifests/project-migration.v1.json` 与 `tasks/status/project-migration-status.v1.json`（键对齐）。不改代码、不改业务文档。
- 验收：两个 JSON 可解析；`npm.cmd run agent:plan` 列出全部子阶段且状态正确；依赖链无环。
- 测试范围：不新增测试文件。

### 步骤 3：Phase 03a 目标 normalizer 重放

- 允许修改：`infra/backfill/`、`modules/observations/`、`scripts/backfill-wait-times-to-postgres.mjs`、`tests/storage/`。
- 禁止：改受保护 bootstrap 脚本；改已应用迁移 0001/0002；改生产 `data/`、`outputs/`。
- 测试范围：重放幂等、raw lineage、open-missing→`null`、closed→`null` 的聚焦断言（追加到 `tests/storage/observation-storage.test.mjs`，不新建重复测试文件）；不重复表征测试。

## 5. 完成定义

- 本 phase 测试与 `npm run check` 通过。
- 无禁止跨模块依赖；diff 无生成物、凭据或无关文件。
- 公共行为变化有文档；失败/降级路径有测试。
