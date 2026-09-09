# ADR 0007: Posted Wait 目标与项目生命周期治理

Status: Accepted

## Context

当前来源能够持续提供 Queue-Times 展示的 posted wait，但没有可靠的游客真实排队到登乘数据，也没有完整的游玩总时长数据。项目需要将真正的 standby 项目、固定时间演出、walkthrough、人物见面和娱乐项目用不同语义处理。仅凭连续 0 或空值不能判断 refurbishment、retired 或恢复开放。

## Decision

- 当前预测目标是 posted standby wait；游客实际等待和游玩总时长属于未来可选的数据产品，不伪造为当前字段。
- 默认训练对象是真正具有 posted standby wait 的游乐设施。人物见面只有在官方或可靠来源提供稳定 posted wait 时才加入；固定时间演出、巡游和娱乐项目使用 schedule constraint；无排队能力的 walkthrough 不进入 standby wait 模型。
- 项目生命周期必须由官方 Disney 页面或官方 App 证据治理。`refurbishment` 保留历史数据但暂不训练和推荐；`retired` 永久保留历史但不训练和推荐；`unknown` 进入人工审核。
- 采集频率保持约 15 分钟。只有在 staging 证明来源稳定、成本可接受且预测收益明显时才评估提高频率。
- 预测 horizon 默认覆盖 30 分钟和 60 分钟，120 分钟作为低置信度的远期参考。10–20 分钟是产品验收方向，具体阈值由 rolling-origin baseline 评估确定。
- 最近 2–3 年作为热数据；更早 raw 数据转入可恢复的对象存储冷归档。

## Consequences

模型不会声称拥有不存在的真实排队 ground truth，catalog 审核成为预测准入的必要条件。规划器需要同时消费 forecast 和 schedule constraints，并为不可用预测提供 fallback。未来如果采集到匿名用户入队/登乘事件，可以新增 experienced-wait 数据集，不覆盖 posted-wait 历史。

## Follow-up

- 为 catalog 增加生命周期证据、有效日期和 `wait_capability`。
- 完成历史 normalized replay 和 parity。
- 建立 30/60/120 分钟 baseline 评估及发布门槛。
- 设计匿名、最小化的用户事件采集方案，再评估真实等待数据的可行性。
