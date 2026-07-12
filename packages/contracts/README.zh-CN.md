# Shared Contracts

## 目的
提供跨模块和应用边界使用的版本化、机器可检查 schema。

## Contract 家族
Catalog entities/mapping、raw source envelope/source health、normalized observation/quality flags、forecast/evaluation metadata、planning request/itinerary/execution event、公共 API request/response。

## 规则
Contract 只描述数据形状和兼容策略，不实现业务规则；每个 contract 只有一个权威格式，生成类型不可手工编辑；breaking change 必须版本化或提供 migration plan；web 依赖 API contract，不依赖数据库。

## 当前状态
目前主要是文档骨架；schema 随模块提取按共享边界优先原则引入。
