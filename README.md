# Disney Park Intelligent Itinerary Planner

面向主题乐园游客的实时智能行程规划系统。项目将园区项目、开放状态、历史与实时排队、演出时间窗、步行成本和游客偏好组合成可执行的单园单日行程，并为后续动态重规划建立数据与算法基础。

An intelligent theme-park itinerary planner that combines park catalogs, live conditions, historical waits, show windows, walking costs, and visitor preferences into a feasible one-park, one-day plan.

[架构总览](docs/architecture/overview.md) · [Project Rules](AGENTS.md) · [迁移路线](docs/architecture/migration-roadmap.md) · [ADR](docs/adr/README.md) · [AI Context Map](docs/ai/context-map.md) · [V0.5 数据质量说明](docs/v0.5-readme.md)

## 项目方向

- **当前验证环境：**自主采集并分析 Disneyland Resort 的 Disneyland Park 与 Disney California Adventure 双园区数据，用于跑通采集、清洗、预测、规划和产品展示的完整链路。
- **首要产品市场：**上海迪士尼度假区和香港迪士尼乐园。
- **未来扩展方向：**奥兰多迪士尼、环球影城及其他主题乐园运营商。
- **当前行程边界：**数据模型支持多运营商和多园区，但一次行程仍限定为一个园区、一个自然服务日。
- **设计原则：**只提前泛化稳定的身份、时区、数据契约和模块边界，不提前实现未经验证的跨园、多日或复杂票务功能。

## 当前阶段

项目处于“治理基础与数据积累”阶段。现有静态网站和 Node.js 数据采集器继续运行；在完成表征测试、正式数据契约和替代存储之前，不对采集器进行行为重构。

| 能力 | 当前实现 | 目标方向 |
| --- | --- | --- |
| 产品界面 | 静态多页面 HTML/CSS/JavaScript | TypeScript + Next.js PWA |
| 数据访问 | 浏览器访问第三方 API，本地 JSON fallback | 自有 API 与版本化 contracts |
| 数据采集 | Node.js 脚本 + GitHub Actions | Collector worker + ingestion adapters |
| 数据存储 | Git 中的 CSV/JSON 过渡数据 | PostgreSQL/时序存储 + raw object storage |
| 数据质量 | Node.js 清洗、canonical mapping、质量报告 | 独立 observations 模块与可回放数据血缘 |
| 排队预测 | 尚未实现 | 可复现基线 + 版本化短期预测与区间 |
| 路线规划 | 尚未实现 | 规则基线 + 时间窗优化 + 动态重规划 |

当前 Git 数据采集只是为了尽快积累可拥有、可检查的历史样本。数据库迁移完成并通过双写/回放验证后，采集器将停止向应用分支提交生产数据；Git 最终只保留小型测试 fixtures 和必要参考数据。

## 当前已实现

- Disneyland Park 与 Disney California Adventure 分园区展示。
- 项目、娱乐演出、园区开放时间和实时状态展示。
- Queue-Times 与 ThemeParks.wiki 数据接入。
- 实时 API 失败时使用本地 JSON cache fallback。
- 五分钟页面刷新与手动刷新。
- Leaflet + OpenStreetMap 地图，以及内置坐标 fallback。
- 地图等待时间分色、列表定位和项目筛选。
- 表演、巡游、烟花和夜间演出的独立日程展示。
- Single Rider 与主项目的关联展示和数据保留。
- 园区营业窗口感知的数据采集。
- CSV 规范化、canonical attraction mapping、数据质量检查。
- optimizer-ready 观测投影与机器/人工可读质量报告。
- 项目规则、模块边界、ADR、AI 最小上下文和治理 CI。

## 目标架构

项目采用 **monorepo 中的模块化单体**，当前不拆成大量微服务。部署进程可以因运行环境不同而分开，但业务规则和数据所有权由领域模块决定。

```text
External park sources
        |
        v
    ingestion -----> catalog
        |
        v
   observations ----> forecasting
        |                  |
        +--------+---------+
                 v
              planning
                 |
                 v
                API <---- web
```

### 核心模块

| 模块 | 独占职责 | 说明 |
| --- | --- | --- |
| [catalog](modules/catalog/README.md) | 园区、项目、演出、别名、access mode、canonical ID | 来源 ID 不作为跨模块主键 |
| [ingestion](modules/ingestion/README.md) | 第三方适配、重试、限流、raw payload、source health | 第三方 API 只能从这里访问 |
| [observations](modules/observations/README.md) | 清洗、状态语义、质量 flags、去重、时序观测 | closed 不等于真实零分钟排队 |
| [forecasting](modules/forecasting/README.md) | 特征、基线、训练、推理、回测、模型版本 | 只消费版本化 observation contracts |
| [planning](modules/planning/README.md) | 偏好、时间窗、步行图、路线评分、重规划与 fallback | 不直接调用任何外部数据源 |

应用与公共能力：

- [`apps/web`](apps/web/README.md)：用户输入与结果展示，不拥有预测和规划规则。
- [`apps/api`](apps/api/README.md)：传输验证、用例编排和依赖注入。
- [`workers/collector`](workers/collector/README.md)：采集任务入口；当前实现仍保留在 `scripts/`。
- [`packages/contracts`](packages/contracts/README.md)：跨模块的版本化 schema 与 API contracts。
- [`packages/domain`](packages/domain/README.md)：少量稳定的共享领域值对象。
- [`packages/testkit`](packages/testkit/README.md)：小型 fixtures、clock 和 replay helpers。
- [`infra`](infra/README.md)：数据库、raw storage、缓存、部署和监控。

更完整的依赖规则和数据流请阅读：

- [Architecture Overview](docs/architecture/overview.md)
- [Domain Context Map](docs/architecture/context-map.md)
- [Dependency Rules](docs/architecture/dependency-rules.md)
- [Data Flow and Lineage](docs/architecture/data-flow.md)

## 开发路线

1. **治理基础：**Project Rules、模块边界、ADR、测试与 CI 骨架。
2. **表征测试：**固定采集窗口、CSV 解析、canonical mapping、closed/zero、stale、Single Rider 和 optimizer selection 的当前行为。
3. **模块提取：**在保持输出和运行命令不变的前提下，拆分现有千行入口。
4. **存储迁移：**引入 raw object storage 与 PostgreSQL/时序存储，回填历史数据并完成双写验证。
5. **产品 API 与 PWA：**通过自有 API 替代浏览器直连第三方来源。
6. **预测与规划：**先建立可复现基线，再加入机器学习、OR-Tools 和滚动重规划。

详细退出条件见 [Migration Roadmap](docs/architecture/migration-roadmap.md)。

## 数据规则摘要

- `canonical_attraction_id` 是跨来源稳定身份。
- 来源 ID 是 adapter 证据，不是跨模块主键。
- 时间以 UTC 持久化，同时保留每个园区的 IANA timezone。
- closed attraction 不产生真实的零分钟 standby wait。
- Standby、Single Rider、virtual queue 等 access mode 必须结构化区分。
- raw observation 不可覆盖；清洗和派生记录必须保留 lineage 与生成版本。
- 预测和路线结果必须包含生成时间及模型/算法版本。

完整强制规则见 [AGENTS.md](AGENTS.md)。可自动检查的规则必须逐步进入 CI，而不能只依赖文档或模型提示词。

## 快速开始

### 本地网站

直接打开 `index.html`，或者启动静态服务器：

```powershell
python -m http.server 5173
```

然后访问 `http://localhost:5173`。

### 数据采集与处理

采集一次等待时间：

```powershell
node scripts/collect-wait-times.mjs
```

规范化已有原始 CSV：

```powershell
node scripts/collect-wait-times.mjs --normalize-only
```

更新 ThemeParks.wiki 本地 cache：

```powershell
node scripts/update-cache.mjs
```

运行数据质量分析：

```powershell
node scripts/analyze-wait-times.mjs
```

只分析、不写入输出：

```powershell
node scripts/analyze-wait-times.mjs --no-write
```

### 治理检查

```powershell
npm run check
```

该命令当前检查治理文件、模块文档、Node 内置测试和现有 JavaScript 语法。随着代码迁移，将继续加入类型、schema compatibility、import boundary、migration 和 dependency-cycle 检查。

## 仓库结构

```text
.
├── AGENTS.md                     # 全项目强制规则
├── apps/                         # 目标 web/API 应用边界
├── modules/                      # 领域模块与所有权文档
├── packages/                     # contracts、domain primitives、testkit
├── workers/                      # 后台任务边界
├── infra/                        # 目标基础设施边界
├── docs/
│   ├── adr/                      # 不可静默改写的架构决策
│   ├── ai/                       # 模型最小阅读路径
│   ├── architecture/             # 架构、依赖、数据流、路线图
│   └── templates/                # 模块文档模板
├── data/                         # 当前过渡历史数据
├── outputs/                      # 当前派生质量报告
├── scripts/                      # 现有采集、分析和治理脚本
├── src/                          # 当前静态网站资源
├── tests/                        # 治理及后续表征/契约/回放测试
├── index.html
├── attractions.html
├── schedule.html
├── map.html
└── package.json
```

## 文档阅读入口

- 新开发任务：先读 [AGENTS.md](AGENTS.md) 和 [AI Context Map](docs/ai/context-map.md)。
- 理解整体系统：读 [Architecture Overview](docs/architecture/overview.md)。
- 修改某个领域：读对应 `modules/<name>/README.md` 与公共 contracts。
- 修改架构决策：新增或 supersede 一个 [ADR](docs/adr/README.md)，不要覆盖历史决定。
- 查看当前数据质量实现：[V0.5 Data Quality README](docs/v0.5-readme.md)。

## English Summary

This repository is building a park-agnostic intelligent itinerary planner. California Disneyland Resort currently provides the two-park data collection and validation environment; Shanghai Disney Resort and Hong Kong Disneyland are the first intended product markets. Future operator and park expansion is supported by explicit IDs, timezones, source mappings, and versioned contracts, while the current itinerary use case remains one park and one service day.

The active implementation is still a static multi-page website with Node.js collection and data-quality scripts. The target is a modular monorepo with catalog, ingestion, observations, forecasting, and planning ownership boundaries, delivered through an owned API and PWA. The current collector remains unchanged until characterization tests and storage migration are ready.

Start with [the architecture overview](docs/architecture/overview.md), [project rules](AGENTS.md), and [the migration roadmap](docs/architecture/migration-roadmap.md).
