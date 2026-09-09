# Observations 模块

## 目的
把来源证据转换为适合 forecasting 和 planning 的 canonical、质量标记时序观测。

## 拥有
等待/状态语义、规范化、去重、quality flags、staleness、血缘和 optimizer-safe projection。

## 不拥有
Vendor HTTP、canonical ID 策略、forecast model 或 route score。

## 公共接口
当前公共入口为 `modules/observations/index.mjs`：

- `normalizeWaitObservation`：实现目标清洗语义；开放项目的空等待保持 `null`，关闭项目不产生等待观测，明确的开放零等待保留为 `0`。
- `auditWaitTimeHistory`：对已解析观测和营业窗口执行确定性历史质量审计。
- `auditRepositoryWaitTimeHistory`：读取当前仓库 bootstrap CSV 与 schedule cache，并返回 `wait-time-history-audit.v1`。

目标接口还包括 normalized observation schema、quality report、latest-state query 和 replay stream。

## 依赖与不变量
依赖 ingestion envelope、catalog identity、schedule 和 persistence port。Closed 不等于真实零分钟等待；stale 保留审计但按版本化策略排除；access mode 保持独立；normalized record 保留 raw lineage 和 transformation version。

## 当前状态与缺口
Bootstrap 主要位于 `scripts/analyze-wait-times.mjs`，迁移前由 characterization tests 保护。当前脚本会把开放项目的空等待字符串转换为零，这是已记录的遗留行为，不是目标 contract。`normalized-wait-observation.v1`、PostgreSQL persistence、默认 standby analysis view、目标清洗函数和历史审计已建立；正式 normalization use case 尚未接入 bootstrap/数据库写入。

审计默认把连续 7 个完整营业日几乎全程关闭的来源项目标记为 `sustained_unavailability_review` 并从预测候选排除，但不能仅凭等待观测断言它是 refurbishment 或永久退役；最终生命周期状态必须由 catalog 的有效期元数据确认。缺少 cleaned 文件的历史日期已由回填器用本模块的 `normalizeWaitObservation` 重放（`infra/backfill`，transformation `target-normalizer.v1`）；parity 报告与实时 normalization use case 尚未接入。
