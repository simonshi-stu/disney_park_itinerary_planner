# 领域上下文地图

## 允许的数据关系

```text
外部乐园来源
      ↓
 ingestion → catalog
      ↓
 observations → forecasting
      └────────────┐
                   ↓
                planning ← 游客偏好/步行图
                   ↓
                  API ← web
```

箭头表示知识或数据流，不允许消费者导入其他模块内部文件。

| 概念 | 所有者 | 消费者 |
| --- | --- | --- |
| 运营商、度假区、园区 | Catalog | 全部模块 |
| Canonical attraction 和别名 | Catalog | ingestion、observations、forecasting、planning、经 API 的 web |
| Vendor payload 和 source health | Ingestion | observations、运维 |
| 等待/状态观测 | Observations | forecasting、planning、API |
| 预测和不确定区间 | Forecasting | planning、API、经 API 的 web |
| 步行边和 itinerary | Planning | API、经 API 的 web |
| HTTP request/response | Contracts/API | web 和外部客户端 |

Ingestion 通过显式 catalog port 解析来源 ID。Observations 接收 ingestion envelope 并发布版本化记录。Forecasting 不读取 vendor JSON。Planning 只消费公共 catalog、observation、forecast、schedule 和 walking contracts。Web 不读取模块内部或数据库行。

所有园区实体显式携带适用的 `operator_id`、`resort_id`、`park_id`。当前 itinerary 明确接受一个园区和一个本地服务日；未来多园行程必须新增 use case 和 ADR。
