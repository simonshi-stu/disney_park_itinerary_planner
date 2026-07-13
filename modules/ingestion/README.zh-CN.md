# Ingestion 模块

## 目的
可靠获取来源数据，并保存足够证据用于回放、归因和健康监控。

## 拥有
来源 adapter、rate limit、retry、raw envelope、来源时间、payload hash、归因 metadata 和 source-health signal。

## 不拥有
Canonical identity 策略、规范化等待语义、forecast 或 itinerary decision。

## 公共接口
目标接口为 source-envelope ingestion、adapter health 和 collection-window command。

## 依赖与不变量
依赖 catalog identity-resolution port、raw object storage port、clock 和来源专属 HTTP adapter。Raw payload 不可变；每个 payload 记录来源、requested/observed/ingested 时间、版本和 hash；outage/stale 是显式状态，不能伪装为空成功响应。

## 当前状态与缺口
Bootstrap 位于 `scripts/collect-wait-times.mjs`、`scripts/update-cache.mjs` 和 GitHub workflow，迁移前保持行为稳定。`raw-archive.v1`、`raw-wait-observation.v1`、S3-compatible archive adapter 和 PostgreSQL raw persistence 已用于历史回填；实时 source-envelope use case、source-health persistence 和 hosted cutover 尚未完成。
