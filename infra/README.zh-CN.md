# Infrastructure 边界

## 目的
拥有 deployment definition、additive database migration、raw object storage configuration、queue/cache、monitoring 和本地开发编排。

## 目标方向
- PostgreSQL 与适当的时序能力保存 normalized observation。
- Object storage 保存 immutable raw payload 和 model artifact。
- Redis 仅用于有明确收益的 cache、session、lock 或短期协调。
- 不同环境使用最小权限的独立 credential。

## 当前状态
已加入 `compose.yaml`、`migrations/0001_observation_storage.sql`、`migrations/0002_catalog_lifecycle_and_indexes.sql`、`migrations/0003_source_health.sql`、`migrations/run-migrations.mjs`、source-health PostgreSQL adapter 和历史回填器。它们建立 PostgreSQL 的 catalog/ingestion/observations schema，并把 raw CSV 先归档到 S3-compatible object storage 后再写入 immutable raw 表；source health 是可 upsert 的派生运行元数据。当前线上采集仍是 GitHub Actions + repository data files；在 hosted storage credential、缺失日期重放、dual-run comparison 和 rollback 验证完成前不切断 bootstrap 写入。

数据库迁移由 `infra/migrations/run-migrations.mjs` 执行。运行前必须设置 `DATABASE_URL`（必填，不在此文档中提供具体值）。迁移使用 `infrastructure.schema_migrations` ledger 表记录已应用的迁移文件名、SHA-256 checksum 和应用时间；执行前通过 PostgreSQL advisory lock（项目专用 key）串行化并发运行。

## 本地验证与回填

先验证仓库历史，不连接数据库：

```powershell
node scripts/backfill-wait-times-to-postgres.mjs --check
```

设置本地专用的 `POSTGRES_PASSWORD`、`MINIO_ROOT_USER`、`MINIO_ROOT_PASSWORD` 后启动服务：

```powershell
docker compose -f infra/compose.yaml up -d
```

回填时设置 `DATABASE_URL`、`RAW_ARCHIVE_BUCKET`、`RAW_ARCHIVE_ENDPOINT`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY` 和 `AWS_REGION`，再运行：

```powershell
node scripts/backfill-wait-times-to-postgres.mjs
```

回填可重复执行；raw 使用内容 hash 和来源行号生成稳定 ID，冲突只跳过，不覆盖。`--skip-upload` 仅用于对象已经归档的环境，并要求 `RAW_ARCHIVE_BASE_URI`。

## 恢复验证（只读）

恢复后的 staging 数据库验证使用只读 verifier，不修改任何数据。运行前必须设置 `RESTORE_DATABASE_URL`（必填，不在此文档中提供具体值），并确认它与 `DATABASE_URL` 指向不同数据库；verifier 会拒绝相同目标。

```powershell
$env:DATABASE_URL = "$env:PROD_DATABASE_URL"
$env:RESTORE_DATABASE_URL = "$env:STAGING_DATABASE_URL"
npm.cmd run db:verify-restore
```

该命令执行只读验证，包括：

- 必需表存在（catalog、ingestion、observations、infrastructure）。
- migration ledger 与文件 checksum 匹配。
- raw 不可变触发器存在。
- normalized 行无 lineage orphan。
- closed 行无 observed wait。
- raw archive 和 observation 计数为正。

验证失败时设置非零退出码。verifier 是只读的；云资源创建和首次恢复必须由人工在 provider 控制台或 secret manager 完成，不自动执行。

详细备份、隔离 staging 恢复、只读 raw hash sampling 与清理流程见[存储备份与恢复运行手册](../docs/data/storage-backup-restore.zh-CN.md)。

## 迁移执行与 checksum 校验

运行迁移（PowerShell）：

```powershell
npm.cmd run db:migrate
```

该命令调用 `infra/migrations/run-migrations.mjs`。迁移文件按词法顺序执行，且必须为 additive。每次应用后，文件名和内容 SHA-256 checksum 写入 ledger。若已应用的迁移文件内容发生变化，checksum 不匹配，运行会 fail-closed：拒绝该迁移并抛出错误，不继续执行后续迁移。

## Source health 与窗口报告

`ingestion.source_health` 由 `infra/source-health-postgres.mjs` 通过 `(source_name, run_id)` upsert。它允许更新派生健康状态，不允许替代或修改 immutable raw 表。source health 写入失败必须在双写结果中显式报告，不能伪装成 hosted raw 成功。

双写窗口报告使用 `node infra/report-dual-write-window.mjs <input.json>`，详情见[双写验证窗口手册](../docs/data/dual-write-window.zh-CN.md)。该命令只读，不自动连接数据库或创建云资源。

## 数据规模与分区决策

当前实现不包含表分区。基于现有采集频率和业务量，三年热窗口内的行数约为 1000 万行；这是数量级估算，不是实测值。分区（如按月 additive online migration）推迟到实测表/索引大小和查询延迟证明有必要时再实施；届时采用 additive online monthly-partition migration，不改变现有数据访问路径。
