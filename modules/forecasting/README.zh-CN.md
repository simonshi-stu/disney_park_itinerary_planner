# Forecasting 模块

## 目的
从版本化观测生成可复现、带不确定性和版本信息的等待预测。

## 拥有
特征、基线、训练、推理、backtest、evaluation metric、model registry metadata 和 forecast interval。

## 不拥有
Vendor fetch、观测清洗、用户界面或 itinerary optimization。

## 公共接口
目标接口包括 forecast request/result、model/evaluation metadata 和 reproducible backtest output。

## 依赖与不变量
只消费版本化 observation contract、catalog attribute、calendar/weather feature port 和 model storage port；不得读取 browser cache 或 raw vendor JSON。每个 forecast 包含 generated time、horizon、model version、input snapshot/version 和 uncertainty/fallback status。

## 当前状态与缺口
尚未实现 production forecast。必须先建立可复现 baseline 和 evaluation dataset，再引入复杂模型。
