# 数据流与血缘

## 目标流水线

```text
vendor response
  → immutable raw source envelope
  → canonical identity resolution
  → normalized observation + quality flags
  → feature snapshot
  → versioned forecast
  → planning input snapshot
  → versioned itinerary
  → execution events / replan trigger
```

Raw envelope 保留来源名称/实体 ID、请求/观测/摄取时间、园区身份、payload hash、raw object 位置、adapter/schema 版本和归因策略。派生记录保留上游 ID/不可变 snapshot ID、生成 schema/code/model 版本、生成时间、质量/fallback 状态和复现参数。

时间戳以 UTC 持久化；catalog 保存园区 IANA timezone；服务日和开园后分钟数按园区时区与营业日程计算。测试覆盖夏令时和跨午夜营业窗口。

## 从 Git 迁移数据库

1. 定义 raw 和 normalized contracts。
2. 用与新数据相同的 ingestion/normalization 接口回填现有文件。
3. 在有限周期执行双写或对比。
4. 切换读取端到数据库。
5. 停止 collector 向应用分支提交生产数据。
6. Git 只保留代表性 fixtures 和文档化 archive。

治理阶段不得删除或改写历史 Git 数据。
