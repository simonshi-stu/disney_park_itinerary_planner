# Observations 模块

## 目的
把来源证据转换为适合 forecasting 和 planning 的 canonical、质量标记时序观测。

## 拥有
等待/状态语义、规范化、去重、quality flags、staleness、血缘和 optimizer-safe projection。

## 不拥有
Vendor HTTP、canonical ID 策略、forecast model 或 route score。

## 公共接口
目标接口包括 normalized observation schema、quality report、latest-state query 和 replay stream。

## 依赖与不变量
依赖 ingestion envelope、catalog identity、schedule 和 persistence port。Closed 不等于真实零分钟等待；stale 保留审计但按版本化策略排除；access mode 保持独立；normalized record 保留 raw lineage 和 transformation version。

## 当前状态与缺口
Bootstrap 主要位于 `scripts/analyze-wait-times.mjs`，迁移前由 characterization tests 保护。当前脚本会把开放项目的空等待字符串转换为零，这是已记录的遗留行为，不是目标 contract。尚无独立 schema package、数据库或 policy version。
