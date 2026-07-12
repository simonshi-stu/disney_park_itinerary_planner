# AI 中文上下文地图

本文件是开发代理的默认阅读入口。除非用户明确要求英文，代理只读取中文版本；英文文件用于外部兼容，不是默认上下文。

## 每次必须阅读

1. 根目录 `AGENTS.md`。
2. 本文件。
3. 最近的适用 `AGENTS.md`。
4. 所属模块的 `README.zh-CN.md`。
5. 任务直接影响的公共 contract 和测试。

不要默认读取全部历史 CSV/JSON、生成报告、cache 或无关模块。

## 任务路由

| 任务 | 最小中文上下文 |
| --- | --- |
| 外部 API 或采集 | `workers/collector/README.zh-CN.md`、`modules/ingestion/README.zh-CN.md`、catalog/observation contracts |
| Canonical ID 或项目元数据 | `modules/catalog/README.zh-CN.md`、catalog contracts 和测试 |
| 清洗或数据质量 | `modules/observations/README.zh-CN.md`、observation contracts 和 fixtures |
| Forecasting | `modules/forecasting/README.zh-CN.md`、observation/forecast contracts、评估测试 |
| 路线优化或重规划 | `modules/planning/README.zh-CN.md`、catalog/forecast/planning contracts、回放测试 |
| 用户界面 | `apps/web/README.zh-CN.md`、API contracts、受影响页面/组件测试 |
| API endpoint | `apps/api/README.zh-CN.md`、所属模块公共接口、API contracts |
| 数据库或部署 | `infra/README.zh-CN.md`、中文数据流和相关 ADR |

## 当前实现位置

- 静态浏览器应用：根 HTML、`src/app.js`、`src/data.js`、`src/styles.css`。
- Bootstrap 采集：`scripts/collect-wait-times.mjs`。
- Bootstrap cache 更新：`scripts/update-cache.mjs`。
- Bootstrap 数据质量/optimizer 投影：`scripts/analyze-wait-times.mjs`。
- 定时采集：`.github/workflows/collect-wait-times.yml`。
- 历史和生成数据：`data/`、`outputs/`、`src/cache/`。

这些是当前实现位置，不代表可以继续把目标架构堆放在这些路径。

## 阅读与文档更新规则

- 优先查看文件列表、公共符号、schema 和测试，再读取最小相关代码。
- 使用小型 fixtures，不复制生产历史。
- 可执行行为与文档冲突时必须报告，不能静默选择。
- 架构边界更新 `docs/architecture/` 或新增 ADR。
- 模块不变量/公共接口更新所属模块 README。
- API/数据形状更新 contract schema。
- 临时进度只更新一个指定状态来源，不能复制到所有 README。
