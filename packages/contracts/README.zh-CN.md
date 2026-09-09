# Shared Contracts

## 目的
提供跨模块和应用边界使用的版本化、机器可检查 schema。

## Contract 家族
Catalog entities/mapping、raw source envelope/source health、normalized observation/quality flags、forecast/evaluation metadata、planning request/itinerary/execution event、公共 API request/response。

## 规则
Contract 只描述数据形状和兼容策略，不实现业务规则；每个 contract 只有一个权威格式，生成类型不可手工编辑；breaking change 必须版本化或提供 migration plan；web 依赖 API contract，不依赖数据库。

## 当前状态
`schemas/v1/` 已定义首批持久化边界：immutable raw archive、raw wait observation、normalized wait observation、wait-time history audit 和 catalog attraction lifecycle。前三者用于历史回填与 PostgreSQL adapter；审计报告用于表达开园时段覆盖、缺失/零等待语义、短暂停运和持续不可用复核候选；catalog lifecycle 用于表达排队能力、支持的 access modes、官方生命周期证据、有效期及训练/规划 disposition。它们都不改变 bootstrap CSV 的格式。

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
