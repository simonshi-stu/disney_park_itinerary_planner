# Shared Contracts

## 目的
提供跨模块和应用边界使用的版本化、机器可检查 schema。

## Contract 家族
Catalog entities/mapping、raw source envelope/source health、normalized observation/quality flags、raw archive-line reference、R2 normalized replay report、forecast/evaluation metadata、planning request/itinerary/execution event、公共 API request/response。

## 规则
Contract 只描述数据形状和兼容策略，不实现业务规则；每个 contract 只有一个权威格式，生成类型不可手工编辑；breaking change 必须版本化或提供 migration plan；web 依赖 API contract，不依赖数据库。

## 当前状态
`schemas/v1/` 已定义首批持久化边界：immutable raw archive、raw wait observation、normalized wait observation、wait-time history audit、catalog attraction lifecycle 和 source health。前三者用于历史回填与 PostgreSQL adapter；审计报告用于表达开园时段覆盖、缺失/零等待语义、短暂停运和持续不可用复核候选；catalog lifecycle 用于表达排队能力、支持的 access modes、官方生命周期证据、有效期及训练/规划 disposition；source health 用于保存可更新的来源运行状态，不替代 immutable raw evidence。它们都不改变 bootstrap CSV 的格式。

`catalog-entry.v1` (`schemas/v1/catalog-entry.schema.json`) 是 catalog resolver 与上层 catalog adapter 共用的注入输入 contract：精确定义 entry version、operator/resort/park identity、aliases、canonical attraction identity/name/category，并通过 `$ref` 复用既有 `catalog-attraction-lifecycle.v1`。两者是不同 contract；本次不修改 lifecycle v1。

`dual-write-window-report.v1` 是只读比较结果，要求调用方提供完整窗口的 expected runs、Git runs、hosted runs 和 source-health 快照；缺失输入不会被推断为成功。`hosted-backfill-report.v1` 是历史回填 checkpoint，逐 archive 对比 Git manifest、Neon raw/normalized lineage 和私有 R2 对象的 key、metadata、内容 SHA-256 与 byte size；它只读验证，不执行回填或删除。hosted 报告保留每个 Git archive 的 hash/count 完整证据，差异明细和 parity mismatch 列表是有界样本，完整总量由 `classification_counts`、`diagnostic_samples` 和 parity check 的计数字段表达；消费方不得把样本数组长度当作差异总数。

`normalized-wait-observation.v2` 是独立的持久化 normalized 记录：记录 UTC 事件时间、operator/resort/park identity、park IANA timezone、canonical identity、access mode、等待值、quality 与 transformation lineage。`raw_observation_id` 对应 `raw-archive-line-reference.v1`，因此读取 normalized 记录不需要连接到 PostgreSQL raw observation payload 行。行引用只保存 R2 URI、archive SHA-256/byte size、archive identity、source line ordinal 和解析版本，不保存 raw payload。

`r2-normalized-replay-report.v1` (`schemas/v1/r2-normalized-replay-report.schema.json`) 是 04d4 注入式 replay 与离线 `--check` 共享的版本化报告 contract，通过 `oneOf` 区分两个互斥 variant：replay variant（`mode` 为 `dry-run`/`write`，包含 run/scope/counts/diagnostics、raw baseline、capacity gate、`next_cursor` 与 `resume`）和 offline-check variant（`mode` 为 `offline_check`，声明 `external_connections_opened: false`）。`next_cursor`/`resume.cursor` 绑定 `scope_id`（完整有序 archive inventory），暂停、失败或重试的续跑必须携带同一 cursor。

## V1 等待时间约束
- 来源在关闭状态返回的 `0` 只属于 raw 证据。
- 关闭项目的 normalized `observed_wait_time_minutes` 必须为 `null`；开放且真实的零等待才允许为 `0`。
- `access_mode` 结构化区分 `standby`、`single_rider`、`virtual_queue` 和 `other`。
- normalized record 必须引用 raw record，并记录 `transformation_version` 与 `generated_at`。
- 当前园区数据的 `snapshot_timezone` 固定为 `America/Los_Angeles`；UTC 时间仍是持久化事件时间。

## V1 Catalog 生命周期约束
- `wait_capability` 与 observation `access_mode` 是不同概念；项目可支持多个 `supported_access_modes`。
- `operational_state` 属于 catalog 有效期记录，不复制到 `normalized-wait-observation.v1`。
- `refurbishment` 和 `retired` 必须同时从训练与规划推荐中排除；`unknown` 必须进入审核。
- operating、refurbishment、seasonal 和 retired 状态至少保留一条官方 Disney 页面或官方 App 证据。
- 恢复开放创建新的有效期记录，不覆盖既有 lifecycle 历史。

## V2 Normalized 持久化边界
- `schemas/v2/normalized-wait-observation.schema.json` 是 v2 normalized persisted record 的唯一 schema source of truth；v1 schema 保持原样。
- 事件时间和生成时间使用 UTC（`Z`），并同时持久化 park identity 与 park timezone，避免从 raw payload 行推导本地日期。
- `raw_observation_id` 是 stable lineage key；其 archive hash/URI/source-line 信息放在 `raw-archive-line-reference.v1` 元数据记录中，raw bytes 仍只保存在 immutable R2 object。
- `normalized_observation_id = SHA-256(UTF-8 `${raw_observation_id}:${transformation_version}`)`。相同 key 的重放仅在 normalized-v2 record 除 `generated_at` 外的每个字段完全相等时才幂等；JSON object 按字段名比较，array 保持顺序比较，不做类型强制或归一化。重放时 `generated_at` 可变化，但 04d3 adapter 必须保留首次写入的值，不能更新它。
- 除 `generated_at` 外，identity、access mode、open/wait、quality flags、training eligibility、park timezone、UTC event time 及其他 v2 字段任一不同，都是 conflicting payload，必须 fail closed，不能以 upsert 静默覆盖。修正必须使用新的 transformation version；catalog snapshot 与 `staleAfterMinutes` 等策略语义必须固定在该 version，或在变更语义时提升 version。04d3 tests 必须证明重放保留初始 `generated_at` 并拒绝冲突。normalized v2 schema 不因此改变。
- `raw_observation_id` 的精确定义为：
  ```text
  raw_observation_id=SHA-256(UTF-8 `${archive_sha256}:${one_based_data_row_ordinal}`)
  ```
  `one_based_data_row_ordinal` 从 1 开始计数且不包含 archive header；normalized v2 与 archive-line reference v1 必须使用相同的结果。
- 关闭项目的 normalized wait 必须为 `null`；开放缺失值可为 `null`，真实开放零等待仍可为 `0`。access mode 与质量标记均为结构化字段。
- 不兼容的 v1 形状变化不得回写 v1；v1 与 v2 按 contract version 并存。未来 writer 切换须先新增 additive storage migration 与双版本 reader/lineage 兼容，再经单独批准的迁移/回放处理历史数据；不得原地改写 v1 或 validation 历史行。

## 持久化兼容性
当前 v1 以及 `0001`–`0003` 建立的历史存储/validation 记录继续按原 contract 读取，不因 v2 发布而删除或重写。04c validation 的既有 raw rows 是历史证据，不是 v2 writer 需要复制的对象。未来 production writer 的 normalized-only 规则及版本切换见 [ADR-0008](../../docs/adr/0008-r2-raw-neon-normalized-persistence.md)；本 contract 变更本身不应用数据库 migration，也不触发 hosted write。
