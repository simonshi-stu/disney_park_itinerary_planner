# Infrastructure 边界

## 目的
拥有 deployment definition、additive database migration、raw object storage configuration、queue/cache、monitoring 和本地开发编排。

## 目标方向
- PostgreSQL 与适当的时序能力保存 normalized observation。
- Object storage 保存 immutable raw payload 和 model artifact。
- Redis 仅用于有明确收益的 cache、session、lock 或短期协调。
- 不同环境使用最小权限的独立 credential。

## 当前状态
已加入 `compose.yaml`、`migrations/0001_observation_storage.sql` 和历史回填器。它们建立 PostgreSQL 的 catalog/ingestion/observations schema，并把 raw CSV 先归档到 S3-compatible object storage 后再写入 immutable raw 表。当前线上采集仍是 GitHub Actions + repository data files；在 hosted storage credential、缺失日期重放、dual-run comparison 和 rollback 验证完成前不切断 bootstrap 写入。

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
