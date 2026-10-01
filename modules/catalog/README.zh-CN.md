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
- `resolveCanonicalAttraction({ parkId, sourceAttractionName, catalogEntries, asOfDate })`：用调用方注入的 catalog 条目确定性解析 canonical attraction，不读取 CSV、数据库或 vendor API。
- 每条注入项必须符合 `packages/contracts/schemas/v1/catalog-entry.schema.json`（`catalog-entry.v1`）：含版本、operator/resort/park identity、aliases、canonical ID/name/category 和嵌套的 `catalog-attraction-lifecycle.v1`；额外字段、版本错误或两层 identity 不一致均失败关闭。
- 别名按 park 精确隔离，未知、冲突或在目标日期无效的映射失败关闭，不猜测 slug。`asOfDate` 是 park-local `YYYY-MM-DD`。
- `Single Rider` 后缀仅可作为 canonical alias 匹配的回退；access mode 必须由调用方以结构化值提供，不能由名称推断。
- Resolver 不把 bootstrap alias CSV 当作已审核的 lifecycle catalog；生产适配器必须注入经过审核的生命周期记录。缺少该证据的条目维持 `unknown`/`review_required`，不得用合成或推测的官方证据标记为 operating。

## 依赖与不变量
只依赖共享领域 primitive 和 persistence port；vendor adapter 消费 catalog，catalog 不调用 vendor。Canonical ID 在改名、季节 overlay、vendor-ID 变化后保持稳定；园区显式记录运营商、度假区和 IANA timezone；access mode 是结构化字段。

生命周期校验遵守 `catalog-attraction-lifecycle.v1`：operating、refurbishment、seasonal 和 retired 记录需要官方 Disney 页面或 App 证据；refurbishment/retired 同时排除训练和规划；unknown 必须进入两者审核。`valid_from` 含当日，非空 `valid_to` 为不含边界的结束日。

## 当前状态与缺口
Bootstrap 映射仍在 `data/catalog/attraction-aliases.csv`、`src/data.js` 和分析脚本；新 resolver 不读取或改变这些路径，消费由上层注入的映射。现有 DCA Soarin、World of Color 与 Disneyland Mickey's House 等 alias 形状由小型 fixture 表征。`catalog-attraction-lifecycle.v1` 已定义排队能力、支持的 access modes、生命周期、官方证据、有效期及训练/规划 disposition；mapping-review workflow 和 persistence layer 尚未实现。

## 生命周期不变量
- `wait_capability` 使用 `posted_standby`、`schedule_only`、`no_queue` 或 `unknown`，不复用 observation 的 `access_mode`。
- `refurbishment` 保留历史但不可训练和推荐；`retired` 保留历史但永久不可训练和推荐；`unknown` 必须审核。
- operating、refurbishment、seasonal 和 retired 必须有官方 Disney 页面或官方 App 证据。
- 状态变化通过 `valid_from`/`valid_to` 新增记录，不覆盖历史。
