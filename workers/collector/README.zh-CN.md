# Collector Worker

## 目的
调度来源采集并把 raw source envelope 交给 ingestion use case。

## 当前状态
运行中的 bootstrap collector 仍是 `scripts/collect-wait-times.mjs`，cache 更新在 `scripts/update-cache.mjs`，调度在 GitHub workflow。本目录的旁路代码不替换该 bootstrap runtime。

`dual-write.mjs` 提供旁路编排接口 `runDualWrite`。它接收不可变 `source-envelope.v1` 和两个注入 writer：`writeGitFallback({ envelope, runId, deduplicationKey })` 与 `writeHosted({ envelope, runId, deduplicationKey })`。有 payload 时去重键固定为 `payload_sha256`，无 payload 的 outage envelope 才使用 `envelope_id`，每次执行记录 `run_id`、来源状态、feature flag 和 hosted 失败原因。`COLLECTOR_DUAL_WRITE_ENABLED` 不是 `true` 时只写 Git fallback；启用后仍先写 Git，再写 hosted。hosted writer 失败会返回结构化 `hosted_write_failed`，不会撤销或阻断 Git fallback；Git fallback 失败则 fail closed，hosted writer 不会被调用。

`run-dual-write.mjs` 是 bootstrap collector 的旁路入口：workflow 先提交本次产生的 Git fallback，再把 commit 结果通过 `COLLECTOR_GIT_FALLBACK_OUTCOME` 传入 sidecar；Git commit 失败时不会尝试 hosted 写入。sidecar 只在本次 workflow 产生新的 `latest_snapshot.json` 时读取 `latest_snapshot.json.rows`，序列化为单次不可变 CSV snapshot。`COLLECTOR_DUAL_WRITE_ENABLED` 是显式 opt-in，默认关闭；开启后 hosted leg 为 normalized-only：R2 先写入完整 snapshot bytes（带 `sha256` 与 `schema_version` metadata；重复 put 使用 `If-None-Match`，命中 412/409 后改为读取并校验既有对象），随后在单个 caller-owned transaction 中通过 04d3 ports 写入 catalog-entry snapshots、archive-line references、normalized v2 与 source-health。它绝不 INSERT `ingestion.raw_wait_observations`；sidecar 的任何路径都不调用 migration runner，`0004` 必须已由人工授权并提前应用，否则 hosted leg 以 `normalized_schema_not_ready` 失败。direct CLI 在 `hosted.status=failed` 时以非零退出码结束（此时 Git fallback 已提交），并只输出 redacted safe message，使 workflow 的 `Surface dual-write failure` 步骤可达。

hosted leg 还要求外部提供的 reviewed `catalog-entry.v1` snapshot、显式结构化 `(park_id, ride_id) -> access_mode` mapping、当前有效的 `validation-only` authorization，以及匹配的 normalized database fingerprint（由 `DATABASE_URL` 的 host/port/database 计算，忽略凭据，并拒绝 `?host=`/`?hostaddr=`/`?port=`/`?database=`/`?db=`/`?dbname=` 等 pg 会合并进连接配置的 routing override，出现时在创建 pool 前 fail closed）。缺项、授权过期或 fingerprint 不匹配都会在 R2/数据库写入前 fail closed，并在结果 `hosted.error.message` 中以安全 code 明确报告；Git fallback 仍然成功可读。成功时结果附加 `normalized_only`（adapter/schema/transformation versions、archive hash、object URI、normalized count、raw insert 0）以及 transaction 内写入的 `source_health`。reviewed inputs 与 authorization 通过非 secret 配置路径提供，实际启用仍需人工 gate。

当 hosted leg 未启用或未尝试时，旁路入口仍可用显式注入的 source-health port upsert `ingestion.source_health`；hosted 失败时也会记录 source status、错误和 hosted failure。当 `COLLECTOR_DUAL_WRITE_ENABLED` 为 false 且没有注入 sourceHealthRepository 时，worker 不创建 hosted database pool，即使环境中存在 `DATABASE_URL` 也返回 `source_health.status=not_configured`；workflow 同样不向该步骤注入 `DATABASE_URL` 或 R2/AWS 凭据。启用后若没有注入 repository，默认 DB fallback 也要求与 normalized-only 完全相同的 current validation-only authorization 与 target fingerprint（含 routing override 拒绝）：缺少/过期/fingerprint 不匹配时返回 `source_health.status=blocked` 且不创建 pool；即使授权有效，`ingestion.source_health` schema 不存在时也返回 `source_health.status=failed`，因为 sidecar 从不应用 migration。source-health 写入本身失败会在结果的 `source_health.status=failed` 中显式报告，不阻断已提交的 Git fallback。Git fallback 自身失败时也会先尝试记录失败 source health，再以非零状态退出；Git fallback 失败时 hosted leg 不会被调用。

## 迁移前提
- 当前 collection window、输出和失败行为有 characterization tests。
- Raw envelope 和 observation contracts 已版本化。
- Raw object storage 和数据库 destination 已建立。
- `0004` normalized schema 已通过人工 gate 应用，并存在当前有效的 validation-only authorization 与匹配的 target fingerprint。
- Backfill、dual-run comparison、cutover、rollback 标准明确。

在这些条件满足前不得重构或停止现有 collector；normalized-only hosted leg 默认关闭，启用属于 human gate，失败时不得切换到 production 或升级 provider plan。sidecar 的任何路径（normalized-only 与 source-health fallback）都不应用 migration，fallback 也只在 schema 已存在时才写入。GitHub Actions 已移除 legacy raw write operation/job（`backfill-hosted-validation`）；旧 raw backfill 仅作为本地历史工具存在，旧 validation branch 已于 2026-09-30 过期，不得作为写入目标；`audit-hosted-backfill` 保持只读。
