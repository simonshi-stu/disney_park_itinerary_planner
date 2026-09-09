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
当前映射仍在 `data/catalog/attraction-aliases.csv`、`src/data.js` 和分析脚本。`catalog-attraction-lifecycle.v1` 已定义排队能力、支持的 access modes、生命周期、官方证据、有效期及训练/规划 disposition；mapping-review workflow、catalog use case 和 persistence layer 尚未实现。

## 生命周期不变量
- `wait_capability` 使用 `posted_standby`、`schedule_only`、`no_queue` 或 `unknown`，不复用 observation 的 `access_mode`。
- `refurbishment` 保留历史但不可训练和推荐；`retired` 保留历史但永久不可训练和推荐；`unknown` 必须审核。
- operating、refurbishment、seasonal 和 retired 必须有官方 Disney 页面或官方 App 证据。
- 状态变化通过 `valid_from`/`valid_to` 新增记录，不覆盖历史。
