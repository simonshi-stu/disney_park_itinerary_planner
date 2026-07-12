# Testkit

## 目的
提供测试共享的小型 builder、clock、contract fixture 和 replay helper，不导入 production adapter。

## 计划 fixtures
开放项目、临时关闭、开放零等待、stale source、Single Rider、娱乐时间窗、改名/source-ID变化、跨午夜或夏令时营业窗口。

## 规则
只使用小而有代表性的测试数据，不复制生产历史；fixture 必须表达业务边界并保持确定性。

## 当前状态
Characterization suite 已有隔离临时目录和小型 fixtures；公共 builder/replay helper 尚未提取。
