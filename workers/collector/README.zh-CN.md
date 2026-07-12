# Collector Worker

## 目的
调度来源采集并把 raw source envelope 交给 ingestion use case。

## 当前状态
运行中的 bootstrap collector 仍是 `scripts/collect-wait-times.mjs`，cache 更新在 `scripts/update-cache.mjs`，调度在 GitHub workflow。本目录未迁移 runtime code。

## 迁移前提
- 当前 collection window、输出和失败行为有 characterization tests。
- Raw envelope 和 observation contracts 已版本化。
- Raw object storage 和数据库 destination 已建立。
- Backfill、dual-run comparison、cutover、rollback 标准明确。

在这些条件满足前不得重构或停止现有 collector。
