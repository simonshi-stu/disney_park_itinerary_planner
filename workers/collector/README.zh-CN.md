# Collector Worker

## 目的
调度来源采集并把 raw source envelope 交给 ingestion use case。

## 当前状态
运行中的 bootstrap collector 仍是 `scripts/collect-wait-times.mjs`，cache 更新在 `scripts/update-cache.mjs`，调度在 GitHub workflow。本目录的旁路代码不替换该 bootstrap runtime。

`dual-write.mjs` 提供旁路编排接口 `runDualWrite`。它接收不可变 `source-envelope.v1` 和两个注入 writer：`writeGitFallback({ envelope, runId, deduplicationKey })` 与 `writeHosted({ envelope, runId, deduplicationKey })`。有 payload 时去重键固定为 `payload_sha256`，无 payload 的 outage envelope 才使用 `envelope_id`，每次执行记录 `run_id`、来源状态、feature flag 和 hosted 失败原因。`COLLECTOR_DUAL_WRITE_ENABLED` 不是 `true` 时只写 Git fallback；启用后仍先写 Git，再写 hosted。hosted writer 失败会返回结构化 `hosted_write_failed`，不会撤销或阻断 Git fallback；Git fallback 失败则 fail closed，hosted writer 不会被调用。

`run-dual-write.mjs` 是 bootstrap collector 的旁路入口：workflow 先提交本次产生的 Git fallback，再把 commit 结果通过 `COLLECTOR_GIT_FALLBACK_OUTCOME` 传入 sidecar；Git commit 失败时不会尝试 hosted 写入。sidecar 只在本次 workflow 产生新的 `latest_snapshot.json` 时读取 `latest_snapshot.json.rows`，序列化为单次不可变 CSV snapshot，在 flag 开启时把该 snapshot archive 写入 S3-compatible object storage，并把对应 raw archive/source rows 幂等写入 PostgreSQL。采集 skip（例如过短间隔或园区不在 collection window）不会重复归档旧 snapshot，也不会伪造 source health 运行。它不修改 bootstrap collector 的采集、解析或 Git 写入语义，也不会重复归档不断增长的日文件。对象 bucket、数据库和凭证必须由部署环境提供；入口不会自动创建云资源。

当提供 `DATABASE_URL` 时，旁路入口还会用 source-health port upsert `ingestion.source_health`，即使 hosted raw 上传失败也会记录 source status、错误和 hosted failure；source-health 写入本身失败会在结果的 `source_health.status=failed` 中显式报告，不阻断已提交的 Git fallback。Git fallback 自身失败时也会先尝试记录失败 source health，再以非零状态退出。

## 迁移前提
- 当前 collection window、输出和失败行为有 characterization tests。
- Raw envelope 和 observation contracts 已版本化。
- Raw object storage 和数据库 destination 已建立。
- Backfill、dual-run comparison、cutover、rollback 标准明确。

在这些条件满足前不得重构或停止现有 collector。
