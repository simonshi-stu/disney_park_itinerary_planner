# 项目进度报告（人类阅读用）

> 最后更新：2026-09-09（按需更新，非固定快照）。
>
> 本文档是**人类阅读的当前进度报告**，不是 Agent 的工作准则，也不是权威状态来源：
> - Agent 的权威进度来源：`tasks/status/project-migration-status.v1.json`。
> - Agent 的工作准则：根 `AGENTS.md` 与 `docs/ai/agent-change-test-charter.zh-CN.md`。
> - Agent 不得依据本文档修改代码或扩大修改范围。

## 一句话现状

项目处于「**存储迁移基本完成、历史重放未开始**」阶段：Phase 0 治理与 Phase 1 表征测试完成；Phase 2 存储基础（contracts、migration runner、lifecycle schema、回填器、只读恢复验证）代码与 live 验证已完成，但**尚未提交入库**；Phase 3–8 已拆分为 19 个原子子阶段，全部待执行。

## 已完成

- **治理基础**：根 `AGENTS.md`、ADR 0001–0007、模块边界、governance CI（`npm run check` 已接入 CI）。
- **表征测试**：锁定 bootstrap 采集/清洗/optimizer 行为的当前语义（采集窗口、CSV、fallback、canonical mapping、closed/zero、stale、Single Rider、重复/冲突等）。
- **Phase 01 数据契约**：catalog 生命周期与 posted-wait 语义 contracts（`catalog-attraction-lifecycle.v1`）+ Node 测试。
- **Phase 02 存储基础**：
  - `infra/migrations/run-migrations.mjs`（词法发现、SHA-256 checksum ledger、advisory lock、fail-closed）。
  - `0001_observation_storage.sql` + `0002_catalog_lifecycle_and_indexes.sql`（PostgreSQL 17 live 验证通过）。
  - 历史回填器（live 回填：29 archives / 162,968 raw / 6,918 normalized）。
  - 只读 restore verifier 与备份恢复手册。
- **目标清洗与审计**：`modules/observations` 的目标清洗函数、历史质量审计与 `wait-time-history-audit.v1`。
- **Agent 编排**：`tools/agent-orchestrator.mjs`（Codex 决策 + DeepSeek 执行）+ 任务 manifest + 修改/测试准则 charter。

## 未完成（下一步）

1. **提交未提交的 Phase 1/2 工作**（当前全部在 `main` 未提交，存在丢失风险）：按 charter 步骤 1 的 5 个逻辑分组提交（工具/编排 → contracts → observations → infra → 进度报告）。
2. **Phase 03a 目标 normalizer 历史重放**：补齐 2026-07-09 至 2026-07-12 缺失 normalized 日期（当前唯一阻塞预测准入的数据前置条件）。
3. **Phase 03b/03c**：parity 报告与重放手册。
4. **Phase 04–08**：采集双写与 source health → FastAPI → Next.js PWA → 预测/规划 baseline → 部署。

manifest 已于 2026-09-09 把原 6 个粗粒度阶段（03–08）拆分为 19 个原子子阶段（03a–08c），可直接用 `npm.cmd run agent:run -- --phase=<id>` 逐条驱动 DeepSeek + Codex 执行。

## 风险与关注

- **未提交工作丢失风险（最高优先级）**：Phase 1/2 全部产物未提交，且违反「每 phase 一个分支/PR」策略。
- **数据缺口**：2026-07-09..07-12 无 cleaned 数据，未通过 parity 前不能进入 training set。
- **语义差异**：遗留 `Number("")→0` 与目标 `null` 语义不同，重放 parity 必须显式处理。
- **仓库副本**：`work/phase3-replay/` 是整个仓库的副本（已被 gitignore），Phase 3 结束后应清理。
- **环境限制**：受限沙箱内 `node --test` 可能因 `spawn EPERM` 失败（环境限制，非代码缺陷）；GitHub Actions 与本机 shell 正常。

## 常用入口

```powershell
npm run check                 # 全部治理与测试（需在 CI/本机运行）
npm run agent:plan            # 查看全部阶段与状态
npm run agent:run -- --phase=03a-history-replay-normalizer --dry-run   # 生成 DeepSeek prompt
npm run agent:run -- --phase=03a-history-replay-normalizer             # 真实执行（需 DEEPSEEK_API_KEY）
node scripts/backfill-wait-times-to-postgres.mjs --check               # 只读回填计划检查
```
