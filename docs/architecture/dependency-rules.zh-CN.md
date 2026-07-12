# 依赖与边界规则

## 模块内部方向

```text
module/
├── public/       # 文档化类型与入口
├── domain/       # entity、value object、确定性规则
├── application/  # use case 与 port
├── adapters/     # database、HTTP、files、vendor SDK
└── tests/
```

`domain` 只依赖标准库和共享领域 primitive；`application` 可以依赖 domain 和 contracts；adapter 向内实现 application port；composition root 负责实例化。

## 禁止依赖

- Domain 依赖 adapter、framework、filesystem、network 或 database。
- 模块导入另一模块的 `internal`、`adapters` 或数据库模型。
- Web 依赖 ingestion/forecasting/planning 实现或 persistence。
- Planning 依赖 vendor payload 或来源专属 ID。
- Forecasting 依赖 UI state、browser cache、路线展示模型或 raw vendor JSON。
- 用通用 `utils` 混放多个所有者的业务规则。

## 公共 contract

- 跨模块 payload 在 `packages/contracts` 中定义版本化 schema/typed interface。
- 模块只暴露消费者所需的最小接口。
- 数据库模型是 adapter 私有细节。
- Event 使用过去式领域名称，并包含 event ID、schema version、发生时间、producer 和 correlation metadata。
- 消费者必须容忍文档允许的 additive fields。

可确定检查的架构规则必须逐步进入 CI，包括 import boundary、schema drift、OpenAPI compatibility、migration immutability 和 dependency cycle。
