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
- `normalizeArchivedWaitObservation({ rawObservation, archiveLineReference, catalogEntries, accessMode, generatedAt })`：纯 use case，消费 raw v1、archive-line reference v1 和注入的 catalog entries，返回 `normalized-wait-observation.v2`。`accessMode` 必须显式提供结构化值；`generatedAt` 必须是 UTC `Z` 时间，transformation version 默认 `target-normalizer.v2`。
- `auditWaitTimeHistory`：对已解析观测和营业窗口执行确定性历史质量审计。
- `auditRepositoryWaitTimeHistory`：读取当前仓库 bootstrap CSV 与 schedule cache，并返回 `wait-time-history-audit.v1`。

目标接口还包括 normalized observation schema、quality report、latest-state query 和 replay stream。

## 依赖与不变量
依赖 ingestion envelope、catalog identity、schedule 和 persistence port。Closed 不等于真实零分钟等待；stale 保留审计但按版本化策略排除；access mode 保持独立；normalized record 保留 raw lineage 和 transformation version。

归档 normalizer 只通过 catalog 公共 resolver 解析 identity；未知 identity、lineage 不一致、无效/不匹配的 park timezone 或未提供的结构化 access mode 均失败关闭。它按 `packages/contracts/README.zh-CN.md` 中的 SHA-256/UTF-8 archive-line 公式校验 raw ID，输出 UTC 事件/生成时间，并按生命周期准入规则避免把 unknown、refurbishment 或 retired 项目用于训练。Closed wait 为 `null`、open-missing 为 `null`、open-zero 保持 `0`；Single Rider/virtual queue 不会被并入 standby。

训练资格只有在经审核 catalog 明确为 `operating`、`eligible` 且 `posted_standby`，输入 mode 为 `standby`、项目开放并有新鲜等待值时才是 `standby_wait_model`。`unknown` 返回 `review_required`；refurbishment/retired 返回 `ineligible_lifecycle`。在生命周期准入通过后，非 standby access mode 返回 `exclude_non_standby_access_mode`；对其余开放、非缺失观测，stale source 返回 `exclude_stale_source`。Stale quality flag 仍保留在输出中。测试用 synthetic lifecycle evidence 只用于隔离分支测试，不是生产 catalog 证据。

`normalized_observation_id` 由 raw archive-line ID 与 `transformation_version` 确定。重放仅在 normalized-v2 record 除 `generated_at` 外的所有字段完全相等时幂等（object 按字段名、array 按顺序精确比较，不做类型强制）；首次写入的 `generated_at` 必须保持不变。access mode、identity、open/wait、quality flags、training eligibility、park timezone、event time 或其他字段不同都必须 fail closed，不能覆盖同 key 记录。修正必须使用新的 transformation version；catalog snapshot 和 `staleAfterMinutes` 等策略语义必须固定在该 version，或因语义改变而提升 version。04d3 persistence adapter 必须拒绝冲突，且测试保留初始 `generated_at`。

后续 R2 replay adapter（04d4）必须注入经过审核的 catalog snapshot，并从结构化输入提供 `accessMode`；不能从 ride name 后缀推断模式，也不能用 bootstrap aliases 冒充已审核 lifecycle。缺少 identity 或 mode 时 normalizer 抛错；adapter 应统计 unresolved identity/missing-mode 数量并 fail closed，不得写入该 archive 的部分 normalized 结果。04d2 不实现此 replay adapter。

## 当前状态与缺口
Bootstrap 主要位于 `scripts/analyze-wait-times.mjs`，迁移前由 characterization tests 保护。当前脚本会把开放项目的空等待字符串转换为零，这是已记录的遗留行为，不是目标 contract；本次 use case 不改变 bootstrap 行为，也不连接数据库或 R2。`normalized-wait-observation.v1`、PostgreSQL persistence、默认 standby analysis view、目标清洗函数、历史审计和 v2 归档 normalizer 已建立；normalizer 尚未接入 production writer。

审计默认把连续 7 个完整营业日几乎全程关闭的来源项目标记为 `sustained_unavailability_review` 并从预测候选排除，但不能仅凭等待观测断言它是 refurbishment 或永久退役；最终生命周期状态必须由 catalog 的有效期元数据确认。缺少 cleaned 文件的历史日期已由回填器用本模块的 `normalizeWaitObservation` 重放（`infra/backfill`，transformation `target-normalizer.v1`）；v2 归档 normalizer 已实现但尚未接入 production writer，parity 报告也尚未接入。
