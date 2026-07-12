# Shared Domain Primitives

## 目的
容纳少量真正跨模块稳定的领域值对象，例如显式 ID、UTC instant、timezone 和 version identifier。

## 边界
不得成为通用业务规则仓库。具有明确所有者的规则留在对应模块；本包不依赖 framework、HTTP、database、file format 或 vendor SDK。

## 当前状态
只有边界文档，尚未加入实现。
