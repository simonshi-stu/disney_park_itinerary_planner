# Ingestion 模块

## 目的
可靠获取来源数据，并保存足够证据用于回放、归因和健康监控。

## 拥有
来源 adapter、rate limit、retry、raw envelope、来源时间、payload hash、归因 metadata 和 source-health signal。

## 不拥有
Canonical identity 策略、规范化等待语义、forecast 或 itinerary decision。

## 公共接口
已实现 source-envelope ingestion：`ingestSourceSnapshot`（`source-envelope.v1`，adapter 与 clock 可注入，输出不可变 envelope）。`source-health.mjs` 提供 `buildSourceHealthRecord`、`recordSourceHealth`、`persistSourceHealthRecord` 和 `compareDualWriteWindow`；source health 是可更新的派生元数据，双写窗口比较要求显式 expected runs 并输出 `dual-write-window-report.v1`。

## 依赖与不变量
依赖 catalog identity-resolution port、raw object storage port、clock 和来源专属 HTTP adapter。Raw payload 不可变；每个 payload 记录来源、requested/observed/ingested 时间、版本和 hash；outage/stale 是显式状态，不能伪装为空成功响应。source-health repository 只通过 `upsertSourceHealth(record)` port 注入；它可以更新健康记录，但不得更新 raw evidence。

## 当前状态与缺口
Bootstrap 位于 `scripts/collect-wait-times.mjs`、`scripts/update-cache.mjs` 和 GitHub workflow，迁移前保持行为稳定。`raw-archive.v1`、`raw-wait-observation.v1`、S3-compatible archive adapter 和 PostgreSQL raw persistence 已用于历史回填；实时 source-envelope 与 source-health use case 已实现，`0003_source_health.sql` 和 PostgreSQL upsert adapter 已加入，04c 的 hosted validation window 仍需在具备目标数据库与 hosted storage 的环境中运行。source health 记录 source failure 和 hosted write 状态，但不解除首次 hosted restore 或正式 cutover 人工门禁。
