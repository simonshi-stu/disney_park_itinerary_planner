# 数据字典与语义契约

本文档是 Disneyland Resort 等待时间数据的业务语义基线。字段结构以
`packages/contracts/schemas/v1/` 中的 JSON Schema 为准；本文档解释业务含义，不能替代 schema。

## 当前产品范围

- 当前采集范围：Disneyland Park 和 Disney California Adventure。
- 当前行程范围：单个园区、单日行程。
- 当前预测目标：来源展示的 posted standby wait，不等同于游客实际等待到登乘的时间。
- 当前采集频率：约 15 分钟；未来可以在成本和来源稳定性允许时提高，但不得在未验证前改变历史语义。

## 时间与单位

| 字段 | 语义 |
| --- | --- |
| `observed_at` | 事件发生时间，必须使用 UTC 保存 |
| `park_local_date` | 依据园区时区解释的营业日 |
| `source_observed_at` | 数据源声称的观测时间；可为空但必须保留原始值 |
| `wait_time_minutes` | 原始来源值，保留 Queue-Times 的原始语义 |
| `observed_wait_time_minutes` | 规范化后的 posted standby wait；关闭时为 `null` |

所有时间均须保留园区时区（当前为 America/Los_Angeles）以便解释开园、闭园和跨午夜营业日。

## 等待值语义

- 关闭项目没有 observed zero-minute standby wait；关闭状态的规范化等待值必须是 `null`。
- 开放项目的显式 `0` 保留为 `0`，并标记 `open_zero`；它可能代表短暂停运、来源占位或真实零等待，不能自动解释为关闭。
- 开放项目空值保留为 `null`，并标记质量原因；不能使用 JavaScript `Number("")` 将其转换为 0。
- 当前数据不能证明游客实际从进入队列到登乘的真实等待，也不能证明完整游玩时长。除非未来增加用户匿名观测或合作数据，否则模型只预测 posted wait。

## 访问模式与项目类型

`access_mode` 必须是独立枚举，不能通过名称后缀推断：

- `standby`
- `single_rider`
- `virtual_queue`
- `future_access`
- `schedule_only`

只有具有真实 standby 排队能力的项目才默认进入等待时间训练集。人物见面如果官方来源提供稳定 posted wait，可以作为 `standby` 或单独的 `meet_greet` 能力加入；没有等待值时只能作为 schedule-only 约束。固定时间演出、巡游和娱乐项目默认作为时间表约束，不伪造等待分钟数。walkthrough 如果没有排队能力，只作为游玩时长/开放状态约束，不进入 standby wait 模型。

## 项目生命周期

`operational_state` 由 catalog 维护，不能只根据等待数据猜测：

- `operating`：官方页面或官方 App 证实正常开放。
- `refurbishment`：官方确认改造或维修；保留历史数据，但当前不可训练、不可推荐。
- `seasonal`：季节性开放；只在有效日期范围内参与训练和规划。
- `retired`：官方确认不再运营；保留历史数据，但永久不可训练、不可推荐。
- `unknown`：证据不足；进入人工审核，不得默认进入生产预测。

停运、改造和恢复必须保留官方 Disney 页面/App 的证据 URL、核验时间、有效起止日期和审核人/自动化运行 ID。不得仅凭连续 0、空值或数据缺失删除或新增项目。

## 数据层级与 lineage

1. `raw`：不可变来源响应或 CSV 归档。
2. `normalized`：依据版本化 normalizer 生成，保留 raw record ID、代码版本和 schema 版本。
3. `derived`：质量报告、训练集、预测和行程，必须记录输入快照、生成时间和算法/模型版本。

任何修正都产生新的 normalized 或 derived 记录，不覆盖 raw 历史。
