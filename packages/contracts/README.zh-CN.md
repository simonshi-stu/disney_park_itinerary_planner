# Shared Contracts

## 目的
提供跨模块和应用边界使用的版本化、机器可检查 schema。

## Contract 家族
Catalog entities/mapping、raw source envelope/source health、normalized observation/quality flags、forecast/evaluation metadata、planning request/itinerary/execution event、公共 API request/response。

## 规则
Contract 只描述数据形状和兼容策略，不实现业务规则；每个 contract 只有一个权威格式，生成类型不可手工编辑；breaking change 必须版本化或提供 migration plan；web 依赖 API contract，不依赖数据库。

## 当前状态
`schemas/v1/` 已定义首批持久化边界：immutable raw archive、raw wait observation 和 normalized wait observation。它们用于历史回填与 PostgreSQL adapter，不改变 bootstrap CSV 的格式。

## V1 等待时间约束
- 来源在关闭状态返回的 `0` 只属于 raw 证据。
- 关闭项目的 normalized `observed_wait_time_minutes` 必须为 `null`；开放且真实的零等待才允许为 `0`。
- `access_mode` 结构化区分 `standby`、`single_rider`、`virtual_queue` 和 `other`。
- normalized record 必须引用 raw record，并记录 `transformation_version` 与 `generated_at`。
- 当前园区数据的 `snapshot_timezone` 固定为 `America/Los_Angeles`；UTC 时间仍是持久化事件时间。
