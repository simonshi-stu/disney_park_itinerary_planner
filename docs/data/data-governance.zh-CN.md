# 数据治理与预测准入

## 数据来源

Queue-Times 是当前 bootstrap 来源，提供 posted wait 快照；ThemeParks Wiki 用于营业时间等辅助信息。来源声称的等待时间不是游客真实体验的 ground truth。所有来源调用必须位于 ingestion adapter，前端和预测代码不得直接请求供应商 API。

官方 Disney 页面和官方 App 是项目生命周期的优先证据。第三方数据只能标记“待审核”，不能据此删除或新增项目。

## 采集与新鲜度

- 目标频率：约 15 分钟。
- 每条记录保留 `requested_at`、`source_observed_at`、`ingested_at`、`observed_at`。
- 每次运行写入 `run_id`、来源健康状态、HTTP/解析错误和记录计数。
- source health 是可更新的派生元数据；raw source envelope、raw archive 和 raw observation 仍不可变。
- 缺少某次 snapshot 不自动补写虚假值；需要在质量报告中标记缺口。
- 未来提高到 5 分钟前，先在 staging 比较来源限流、成本、缺失率和预测收益。

## 项目准入

预测和推荐默认只使用：

```text
operational_state = operating
wait_capability = posted_standby
access_mode = standby
training_eligibility = eligible
```

以下项目保留数据但不进入训练或推荐：

- refurbishment
- retired
- unknown
- 官方确认关闭的有效日期范围
- 长期不可用且尚未完成 catalog 审核的项目

恢复开放必须重新由官方证据确认，并从恢复后的观测开始评估，不自动把改造期间的数据拼接成连续运营历史。

## 质量门槛

每次训练或发布前必须检查：

- raw 到 normalized 的 lineage 完整。
- 关闭项目没有 observed zero-minute wait。
- 开放空值和开放 0 被区别处理。
- 营业窗口覆盖率达到配置门槛。
- 缺口、重复、stale 和冲突记录有可解释结果。
- catalog 生命周期状态已审核。
- 训练数据快照、normalizer 版本和 schema 版本可重放。

当前数据只能进入审计和 baseline 研究，不得因为“有 29 天 CSV”就自动晋级生产预测；现阶段仍有完整营业日缺口和未完成历史正规化。

## 保存与成本策略

- 最近 2–3 年：PostgreSQL 中保存可查询的 normalized、质量和模型特征数据；raw payload 放对象存储。
- 更早历史：转为对象存储冷归档，保留 hash、manifest 和恢复说明。
- raw 归档默认不可变；删除或缩短保留期需要人工审批并记录 ADR/运行日志。
- 正式生产必须有备份和恢复演练；免费数据库只用于 prototype/staging，不作为唯一生产副本。
