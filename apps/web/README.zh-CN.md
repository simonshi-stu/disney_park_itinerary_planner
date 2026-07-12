# Web 应用边界

## 目的
收集游客偏好，展示园区状态、预测、行程时间线、地图、不确定性和重规划解释。

## 边界
目标 Web 只消费自有 API contracts，不直接调用 park vendor，不拥有 canonical identity、forecasting 或 planning 决策，也不读取数据库表。

## 当前状态
当前静态应用仍位于根 HTML 和 `src/`；本目录现在只有目标边界文档，runtime 尚未迁移。

## 方向
在 API contracts 和行为基线稳定后，逐步引入 TypeScript/Next.js PWA，同时保持现有体验可运行。
