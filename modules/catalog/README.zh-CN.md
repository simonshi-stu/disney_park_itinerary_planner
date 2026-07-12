# Catalog 模块

## 目的
为运营商、度假区、园区、项目、演出、入口和 access mode 提供稳定身份与元数据。

## 拥有
- `operator_id`、`resort_id`、`park_id`、`canonical_attraction_id`。
- 来源别名和来源到 canonical 的映射。
- 园区时区、持久项目元数据、access-mode 词汇。

## 不拥有
实时等待、来源抓取、预测、步行成本或行程评分。

## 公共接口
目标接口包括 catalog lookup、alias resolution、版本化 snapshot 和 mapping-review event。代码迁入前先在 `packages/contracts` 定义 schema。

## 依赖与不变量
只依赖共享领域 primitive 和 persistence port；vendor adapter 消费 catalog，catalog 不调用 vendor。Canonical ID 在改名、季节 overlay、vendor-ID 变化后保持稳定；园区显式记录运营商、度假区和 IANA timezone；access mode 是结构化字段。

## 当前状态与缺口
当前映射仍在 `data/catalog/attraction-aliases.csv`、`src/data.js` 和分析脚本。尚无版本化 catalog schema、mapping-review workflow 或 persistence layer。
