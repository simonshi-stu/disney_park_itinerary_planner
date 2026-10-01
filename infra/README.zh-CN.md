# Infrastructure 边界

## 目的
拥有 deployment definition、additive database migration、raw object storage configuration、queue/cache、monitoring 和本地开发编排。

## 目标方向
- PostgreSQL 与适当的时序能力保存 normalized observation。
- Object storage 保存 immutable raw payload 和 model artifact。
- Redis 仅用于有明确收益的 cache、session、lock 或短期协调。
- 不同环境使用最小权限的独立 credential。

## 当前状态
已加入 `compose.yaml`、`migrations/0001_observation_storage.sql`–`0003_source_health.sql`、`migrations/0004_r2_lineage_normalized_observations.sql`、`migrations/run-migrations.mjs`、source-health PostgreSQL adapter 和历史回填器。0004 与三个 normalized-only repository 是本地实现，尚未授权或应用；它们不修改既有 raw observation 路径。既有迁移建立 PostgreSQL catalog/ingestion/observations schema，并把 raw CSV 先归档到 S3-compatible object storage 后再写入 immutable raw 表；source health 是可 upsert 的派生运行元数据。04c hosted dual-write window 已在私有 R2 和 Neon validation branch 上通过，机器可读证据位于 `docs/data/dual-write-window-2026-09-24.input.json` 与 `.report.json`。当前线上采集仍保留 GitHub Actions + repository data files；正式 production cutover、rollback 验证和停止 bootstrap 写入仍需人工 gate。

数据库迁移由 `infra/migrations/run-migrations.mjs` 执行。普通 `runMigrations({ pool })` 与默认 CLI 固定最多应用 `0001`–`0003`，较新迁移列在 `deferred`，因此现有 collector/backfill worker 不会因发现新 SQL 自动应用它。只有精确的 validation-only 选项 `authorizeValidationOnlyMigration: "0004_r2_lineage_normalized_observations.sql"` 或 CLI `--authorize-validation-only-0004` 才会选择 0004；不得对 production 使用该 opt-in，且 hosted validation 仍须先通过 manifest 的人工 gate。未知 API/CLI 参数在连接数据库前失败。迁移使用 `infrastructure.schema_migrations` ledger 表记录文件名、SHA-256 checksum 和应用时间；执行前通过 PostgreSQL advisory lock 串行化并发运行，并校验迁移目录中所有已应用文件（包括 deferred 文件）的 checksum。

每个 SQL migration 自己包在事务中；runner 随后以独立 ledger `INSERT` 记录成功。如果进程在 SQL `COMMIT` 后、ledger insert 前退出，重试会重新执行该 migration；因此 additive SQL 必须可安全重试。0004 使用 `CREATE ... IF NOT EXISTS`、可替换函数与先删后建新表 trigger，重试不会改写数据；ledger 冲突/校验失败不得用 upsert 掩盖。默认 worker 即使发现 ledger 已有 0004 也只校验其 checksum 并继续兼容，既不应用也不拒绝它。

显式命令仅用于经授权的 validation migration gate（本地实现和自动化测试不得执行它）：

```powershell
node infra/migrations/run-migrations.mjs --authorize-validation-only-0004
```

运行前必须确认 `DATABASE_URL` 指向获批的 validation database；命令本身不判断 URL 所属环境。不得把该命令接入 collector、backfill、部署 workflow 或 production。

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

回填可重复执行；raw 使用内容 hash 和来源行号生成稳定 ID，冲突只跳过，不覆盖。`--skip-upload` 仅用于对象已经归档的环境，并要求 `RAW_ARCHIVE_BASE_URI`。hosted validation 的写入入口是 `.github/workflows/collect-wait-times.yml` 的 `backfill-hosted-validation` 手动 operation；只允许从 `feat/04c-hosted-validation` 运行并要求显式输入 `validation-only`。同一 workflow 的 `audit-hosted-backfill` operation 只读核对，不执行对象上传或数据库写入。两个 operation 均使用 `hosted-backfill-report.v1`；未通过 Git/Neon/R2/parity 全部匹配前不得清理本地数据。

回填 workflow 使用现有 `DATABASE_URL`、`RAW_ARCHIVE_BUCKET`、`RAW_ARCHIVE_ENDPOINT` 和最小权限对象存储凭据；人工运行前必须再次确认 `DATABASE_URL` 是 Neon validation branch，而不是 production。对象存储或 Neon 超载、配额不足、订阅中断或凭据暂时失效时，不重试到 production，也不关闭采集：保留 GitHub Actions 的 Git fallback，记录 source-health/hosted failure，待服务恢复后按 hash 幂等补写并重新生成报告。

## 恢复验证（只读）

恢复后的 staging 数据库验证使用只读 verifier，不修改任何数据。运行前必须设置 `RESTORE_DATABASE_URL`（必填，不在此文档中提供具体值），并确认它与 `DATABASE_URL` 指向不同数据库；verifier 会拒绝相同目标。

```powershell
$env:DATABASE_URL = "$env:PROD_DATABASE_URL"
$env:RESTORE_DATABASE_URL = "$env:STAGING_DATABASE_URL"
npm.cmd run db:verify-restore
```

该命令执行只读验证，包括：

- 必需表存在（catalog、ingestion、observations、infrastructure）。
- `0001`–`0003` 始终要求 ledger 存在且 checksum 匹配；未应用的 gated `0004` 报告为 `deferred_optional`，不使旧恢复失败。若 ledger 已记录 `0004`，则校验其 checksum，并检查 archive-line、normalized-v2、catalog snapshot 三张新表及各自的 immutable trigger。
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

该命令调用 `infra/migrations/run-migrations.mjs`，默认仍只到 0003，并显式报告 deferred migration。迁移文件按词法顺序执行，且必须为 additive。每次应用后，文件名和内容 SHA-256 checksum 写入 ledger。若已应用的迁移文件内容发生变化，checksum 不匹配，运行会 fail-closed：拒绝该迁移并抛出错误，不继续执行后续迁移。`0004_r2_lineage_normalized_observations.sql` 不属于默认命令的执行范围。

04d3 的 archive-line、catalog 与 normalized PostgreSQL repositories 接收同一个调用方事务中的 client，不自行发送 `BEGIN`、`COMMIT` 或 `ROLLBACK`；裸 pool client 会被拒绝，且 repository 在每个 public method 调用时重新校验它捕获的唯一 transaction token。即使 pool 随后复用同一 client，旧 repository 也不能在新事务内使用。use case 必须通过 `withPostgresStorageTransaction(pool, callback)` 将所有写入（包括既有 source-health adapter）组合到单一事务；任一 port 失败时整体 rollback，不能留下部分 reference/catalog/normalized 写入。transaction-scoped advisory locks 与冲突读取都依赖此边界。若 `COMMIT` 结果不确定，或 `ROLLBACK` 失败，wrapper 以 `client.release(error)` 销毁连接，不将可能处于脏事务状态的 client 返回 pool；普通写入失败且 rollback 成功时才正常释放。

### Validation 容量 gate

当前 controller 提供的容量观测为 Free plan 512 MiB、现有数据库约 253 MiB、预计 replay 约 457,840 条；本地实现未连接数据库，未独立核实这些值。用紧凑代表性字符串作乐观估算，每对 normalized 与 archive-line heap 约 718 bytes，457,840 对约 313 MiB heap；主键及必要的 park/event-time B-tree 再约 82 MiB，增量基线约 395 MiB，尚未计空闲页、膨胀、catalog/source-health 和真实 URI/名称长度，因此实际需求可能更高。额外的 `(raw_observation_id, transformation_version)` 与 `(archive_sha256, source_line_number)` B-tree 未重复创建：对应 repositories 在插入前分别重算 normalized key 与 archive-line key，主键已能拦截同一稳定 key；不可绕过 repositories 直接写这些表。04d4 完整性核对必须从已重新验证的 R2 内容 SHA-256 与一基数据行 ordinal 计算 `raw_observation_id`，再通过该主键查找 Neon reference；不得为 completeness 扫描 `archive_sha256` 或新增未批准索引。现有名义余量约 259 MiB，因此**全量 replay 很可能无法在当前 Free 容量内完成**；此估算不是写入许可或实测保证。

任何 0004 validation apply 或历史写入之前，必须先人工进行容量 preflight：读取当前数据库与关系/索引大小，在小批量受控验证中测量实际每行增量和增长速率，并明确 stop threshold 与保留余量。04d4 replay 必须使用有限、可暂停的 batch 和逐批 lineage/parity 检查；不得执行 unbounded validation writes，不得通过升级 plan 绕过容量 gate。容量不足时停止并提交测量结果供人工决定，不得继续回放或删改既有 raw/history。

截至 2026-09-30，原 validation branch 已到声明的到期日；不得假定旧 branch 或旧容量观测仍可作为写入目标/授权。任何 hosted migration 或数据写入均保持阻塞，直到人工确认一个当前有效、单独批准的 validation target，并完成实际容量 preflight 与分批 stop thresholds；production 不是替代目标。

## Source health 与窗口报告

`ingestion.source_health` 由 `infra/source-health-postgres.mjs` 通过 `(source_name, run_id)` upsert。它允许更新派生健康状态，不允许替代或修改 immutable raw 表。source health 写入失败必须在双写结果中显式报告，不能伪装成 hosted raw 成功。

双写窗口报告使用 `node infra/report-dual-write-window.mjs <input.json>`，详情见[双写验证窗口手册](../docs/data/dual-write-window.zh-CN.md)。该命令只读，不自动连接数据库或创建云资源。

## 数据规模与分区决策

当前实现不包含表分区。基于现有采集频率和业务量，三年热窗口内的行数约为 1000 万行；这是数量级估算，不是实测值。分区（如按月 additive online migration）推迟到实测表/索引大小和查询延迟证明有必要时再实施；届时采用 additive online monthly-partition migration，不改变现有数据访问路径。
