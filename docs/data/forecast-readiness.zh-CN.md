# Forecast Readiness 与模型准入

## 预测目标

当前目标是预测项目的 posted standby wait，不是游客实际排队到登乘的时长，也不是完整游玩时长。默认预测窗口为未来 30 分钟和 60 分钟；120 分钟作为日程规划的较远参考，必须明确展示更大的不确定性。

## 训练数据

训练集只包含经过 catalog 和质量门槛批准的 `standby` 项目。refurbishment、retired、unknown 和官方确认关闭期间的数据保留用于历史分析，但不可用于当前训练或推荐。固定时间演出和没有 standby wait 的 walkthrough/娱乐项目进入 planning schedule，而非 wait model。

## 评估

- 使用按时间顺序的 rolling-origin 或 time-based split，禁止随机打乱造成未来信息泄漏。
- 至少报告 MAE、WAPE、样本覆盖率和预测区间覆盖率。
- 10–20 分钟是产品可接受误差方向，不是未经 baseline 验证就能硬编码的保证；应按项目、时段和预测 horizon 分层验收。
- 若 30/60 分钟模型超过用户可接受误差，系统必须展示低置信度并退化到最近观测/历史基线，而不是伪装成精确预测。
- 每个 forecast 必须记录生成时间、模型/算法版本、训练快照、输入 freshness 和适用的 catalog 版本。

## 发布门槛

模型只有在数据覆盖、生命周期审核、时间切分评估和区间覆盖率均通过时，才允许被 API 和规划器使用。规划器必须能识别 forecast 不可用，并使用可解释的 fallback。
