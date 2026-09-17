# 数据存储迁移运行手册

> 独立备份与恢复演练手册：`docs/data/storage-backup-restore.zh-CN.md`。恢复演练、隔离 staging 验证与清理流程以该文档为准。

## 目标架构

```text
source API -> ingestion adapter -> immutable object storage (raw)
                              -> PostgreSQL (metadata/catalog/normalized)
                              -> FastAPI -> Next.js
```

Git CSV 在迁移完成前保留为 bootstrap fallback 和审计证据，不能继续扩展为永久存储。

## 阶段与检查点

1. **准备**：确认云区域、预算、数据库 URL、对象存储 bucket、备份策略和访问权限。
2. **Schema**：只添加新 migration；先 dry-run，再在 staging 应用。migration runner 必须记录版本并支持重复执行检查。**Checkpoint**：`npm.cmd run db:migrate` 成功且 migration ledger 与文件 checksum 匹配；随后按 `docs/data/storage-backup-restore.zh-CN.md` 执行一次隔离 staging 恢复演练，`npm.cmd run db:verify-restore` 必须通过。首次恢复演练由人工执行，hosted 凭证录入与首次恢复均为人工门禁。
3. **Raw 回放**：按 archive hash 上传 raw；重复运行不得产生重复 raw 记录。
4. **Normalized 回放**：使用目标 normalizer 重放所有历史日期，保留 raw lineage。
5. **Parity**：比较 raw/normalized 数量、hash、关闭/0 值语义、canonical identity、营业窗口和缺口。
6. **双写**：bootstrap collector 同时写 Git fallback 和 hosted storage，至少观察一个完整验证窗口。
7. **切换**：API 先从 PostgreSQL 读取；异常时只读 fallback，不回写伪造数据。
8. **回滚**：在接受 checkpoint 前保留 Git 读取路径和旧静态站点；通过 feature flag 恢复读取，不删除 raw。
9. **收尾**：确认备份、恢复演练、成本监控和健康检查后，才停止 Git 数据提交。

每个阶段必须生成机器可读结果，至少包含 `run_id`、输入快照、代码/schema 版本、计数、失败原因和下一步建议。Agent 可以自动重试幂等阶段，但遇到数据删除、生产切换或账单权限变更必须暂停。

## 重放与 Parity 操作

Stage 3–5 的只读命令、幂等性与门槛如下。命令只依赖仓库数据，以及 `DATABASE_URL` 指向的目标 PostgreSQL 和已上传的 raw archive。

### 命令

```powershell
node scripts/backfill-wait-times-to-postgres.mjs --check   # 只读：生成回放计划与统计，不写数据库
node scripts/backfill-wait-times-to-postgres.mjs           # 写入：上传 raw archive 并以目标 normalizer 重放 normalized 行
node scripts/report-replay-parity.mjs                      # 只读 parity：输出机器可读报告
node scripts/report-replay-parity.mjs --date=2026-07-09    # 只读 parity：只比较单日
```

Parity CLI 在只读事务中执行 SELECT，不运行 migration、不写数据。缺少 `DATABASE_URL`、数据库不可达或读取失败时输出 `status: "blocked"` 并把全部日期列入 `excluded_dates`（fail-closed）；`status` 不是 `passed` 时进程以非零退出码结束。

### 幂等性

- raw archive 按 SHA-256 识别，同一文件重复上传不产生重复 archive。
- normalized 行由 `(raw_observation_id, transformation_version)` 唯一约束去重，重放相同 transformation version 不产生重复行。
- raw 表由数据库触发器保证不可变；重放只新增或复用 normalized 行，不改写 raw。
- Stage 3–4 因此可安全重复执行；`--check` 与 parity 报告是只读的。

### Parity 门槛

报告按日期比较 raw/normalized 计数、archive hash、closed/zero 语义、raw lineage、canonical identity 与营业窗口覆盖：

- 只有出现在 `training_eligible_dates` 的日期可以进入 forecast training set。
- 任一检查不通过的日期进入 `excluded_dates`；无法归因到单日的全局不一致（例如 orphan normalized 行）按 fail-closed 排除全部日期。
- 报告含 `run_id`、`checked_at`、`status`、counts、failures 与 next_steps，须与输入快照一起留档。

### 缺口关闭条件

当前盘点确认 2026-07-09 至 2026-08-04 共 27 个 raw-only 日期（有 raw、无对应 cleaned artifact）。单个日期的关闭条件：

1. 出现在重放计划的 normalized 输出中（`target-normalizer.v1`，保留 raw lineage）；
2. 在具备 raw object storage 与已回填目标数据库的环境中运行 `node scripts/report-replay-parity.mjs`；
3. 该日期出现在报告的 `training_eligible_dates` 中。

满足以上三条前，这些日期不得进入 forecast training set，也不得作为切换依据。

## 当前阻塞

当前 normalized 历史只覆盖部分日期，不能跳过 replay/parity 直接切换。未通过 parity 的日期不能进入 forecast training set。

> 该阻塞在 Phase 2 checkpoint 中保持不变；checkpoint 只验证 schema 与恢复能力，不解除 replay/parity 前置条件。

## 密钥与权限

- 凭证只存在于本地 secret store、GitHub Environment secrets 或云端 secret manager。
- Workflow 优先使用 OIDC 短期凭证，不把长期云密钥写入仓库。
- staging 和 production 使用不同数据库、bucket 和最小权限角色。
- 公开仓库不得包含连接字符串、访问令牌、Cookie 或私人 endpoint。
