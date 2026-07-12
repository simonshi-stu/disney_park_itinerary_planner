# Disney Park Intelligent Itinerary Planner

面向主题乐园游客的实时智能行程规划系统。项目将园区项目、开放状态、历史与实时排队、演出时间窗、步行成本和游客偏好组合成可执行的单园单日行程，并为后续动态重规划建立数据与算法基础。

An intelligent theme-park itinerary planner that combines park catalogs, live conditions, historical waits, show windows, walking costs, and visitor preferences into a feasible one-park, one-day plan.

[中文版](#中文版) · [English](#english-version)

[架构总览](docs/architecture/overview.zh-CN.md) · [Project Rules](AGENTS.md) · [迁移路线](docs/architecture/migration-roadmap.zh-CN.md) · [ADR](docs/adr/README.md) · [AI 中文上下文](docs/ai/context-map.zh-CN.md) · [V0.5 数据质量说明](docs/v0.5-readme.md)

## 中文版

## 项目方向

- **当前产品与开发范围：**以加州 Disneyland Resort 的 Disneyland Park 与 Disney California Adventure 为当前产品对象，自主采集双园区数据，并围绕这两个园区完成采集、清洗、预测、规划和产品展示的完整链路。
- **当前 MVP：**先把加州迪士尼双园区的数据基础和单园单日规划产品真正开发完成，不为尚未接入的园区增加当前需求。
- **未来扩展方向：**完成加州产品验证后，再评估上海迪士尼、香港迪士尼、奥兰多迪士尼、环球影城及其他主题乐园。
- **当前行程边界：**数据模型支持多运营商和多园区，但一次行程仍限定为一个园区、一个自然服务日。
- **设计原则：**只提前泛化稳定的身份、时区、数据契约和模块边界，不提前实现未经验证的跨园、多日或复杂票务功能。

## 当前阶段

项目处于“迁移前行为锁定与数据积累”阶段。治理基础和首轮表征测试已经建立，现有静态网站和 Node.js 数据采集器继续运行；测试已覆盖采集窗口两端、CSV 规范化、API/cache fallback、collector failure、canonical mapping、closed/zero、stale、缺失等待值的当前行为、Single Rider、重复/冲突报告和 optimizer-ready selection。在正式数据契约和替代存储就绪之前，不对采集器进行行为重构。

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
- 迁移前 bootstrap 行为表征测试，使用小型 fixtures 锁定采集、清洗和 optimizer 投影语义。
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
| [catalog](modules/catalog/README.zh-CN.md) | 园区、项目、演出、别名、access mode、canonical ID | 来源 ID 不作为跨模块主键 |
| [ingestion](modules/ingestion/README.zh-CN.md) | 第三方适配、重试、限流、raw payload、source health | 第三方 API 只能从这里访问 |
| [observations](modules/observations/README.zh-CN.md) | 清洗、状态语义、质量 flags、去重、时序观测 | closed 不等于真实零分钟排队 |
| [forecasting](modules/forecasting/README.zh-CN.md) | 特征、基线、训练、推理、回测、模型版本 | 只消费版本化 observation contracts |
| [planning](modules/planning/README.zh-CN.md) | 偏好、时间窗、步行图、路线评分、重规划与 fallback | 不直接调用任何外部数据源 |

应用与公共能力：

- [`apps/web`](apps/web/README.zh-CN.md)：用户输入与结果展示，不拥有预测和规划规则。
- [`apps/api`](apps/api/README.zh-CN.md)：传输验证、用例编排和依赖注入。
- [`workers/collector`](workers/collector/README.zh-CN.md)：采集任务入口；当前实现仍保留在 `scripts/`。
- [`packages/contracts`](packages/contracts/README.zh-CN.md)：跨模块的版本化 schema 与 API contracts。
- [`packages/domain`](packages/domain/README.zh-CN.md)：少量稳定的共享领域值对象。
- [`packages/testkit`](packages/testkit/README.zh-CN.md)：小型 fixtures、clock 和 replay helpers。
- [`infra`](infra/README.zh-CN.md)：数据库、raw storage、缓存、部署和监控。

更完整的依赖规则和数据流请阅读：

- [架构总览](docs/architecture/overview.zh-CN.md)
- [领域上下文地图](docs/architecture/context-map.zh-CN.md)
- [依赖与边界规则](docs/architecture/dependency-rules.zh-CN.md)
- [数据流与血缘](docs/architecture/data-flow.zh-CN.md)

## 开发路线

1. **治理基础（已建立）：**Project Rules、模块边界、ADR、测试与 CI 骨架。
2. **表征测试（已完成迁移前基线）：**已固定采集窗口、CSV 解析、API/cache fallback、collector failure、canonical mapping、closed/zero、stale、缺失等待值、Single Rider、重复/冲突报告和 optimizer selection 的当前行为。
3. **模块提取：**在保持输出和运行命令不变的前提下，拆分现有千行入口。
4. **存储迁移：**引入 raw object storage 与 PostgreSQL/时序存储，回填历史数据并完成双写验证。
5. **产品 API 与 PWA：**通过自有 API 替代浏览器直连第三方来源。
6. **预测与规划：**先建立可复现基线，再加入机器学习、OR-Tools 和滚动重规划。

详细退出条件见 [迁移路线](docs/architecture/migration-roadmap.zh-CN.md)。

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

### 测试与治理检查

仅运行迁移前行为表征测试：

```powershell
npm run test:characterization
```

运行全部当前检查：

```powershell
npm run check
```

该命令当前检查治理文件、模块文档、治理测试、[bootstrap 行为表征测试](tests/characterization/README.md)和现有 JavaScript 语法。表征测试在临时目录中执行真实 CLI 入口，不访问实时 API，也不修改仓库里的生产数据。随着代码迁移，将继续加入类型、schema compatibility、import boundary、migration 和 dependency-cycle 检查。

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

- 新开发任务：先读 [AGENTS.md](AGENTS.md) 和 [AI 中文上下文](docs/ai/context-map.zh-CN.md)。
- 理解整体系统：读 [中文架构总览](docs/architecture/overview.zh-CN.md)。
- 修改某个领域：读对应 `modules/<name>/README.zh-CN.md` 与公共 contracts。
- 修改架构决策：新增或 supersede 一个 [ADR](docs/adr/README.md)，不要覆盖历史决定。
- 查看当前数据质量实现：[V0.5 Data Quality README](docs/v0.5-readme.md)。

## English Version

### Product direction

This repository builds an intelligent itinerary planner for Disneyland Park and Disney California Adventure at Disneyland Resort in California. These parks are the current product scope, development target, self-collected data environment, and end-to-end validation environment.

- **Current MVP:** complete the California data foundation and one-park, one-day itinerary product before expanding elsewhere.
- **Future possibilities:** Shanghai, Hong Kong, Orlando, Universal, and other parks are not current implementation requirements.
- **Itinerary boundary:** domain identifiers can represent multiple parks and operators, but one itinerary covers one park and one service day.
- **Design principle:** generalize stable identities, timezones, contracts, and module boundaries without prematurely implementing multi-park, multi-day, or complex ticketing features.

### Current stage

The project is in the migration-preparation and behavior-locking stage. Governance and the initial characterization baseline are complete, while the existing static site and Node.js data pipeline remain operational. The suite covers both collection-window boundaries, CSV normalization, API/cache fallback, collector failure, canonical mapping, closed/zero semantics, stale data, the current missing-wait behavior, Single Rider, duplicate/conflict reporting, and optimizer-ready selection.

| Capability | Current implementation | Target direction |
| --- | --- | --- |
| Product UI | Static multi-page HTML/CSS/JavaScript | TypeScript + Next.js PWA |
| Data access | Browser reads third-party APIs with local JSON fallback | Owned API and versioned contracts |
| Collection | Node.js scripts + GitHub Actions | Collector worker + ingestion adapters |
| Storage | Transitional CSV/JSON data committed to Git | PostgreSQL/time-series storage + raw object storage |
| Data quality | Node.js normalization, canonical mapping, and reports | Independent observations module with replayable lineage |
| Forecasting | Not implemented | Reproducible baseline + versioned short-term forecasts |
| Planning | Not implemented | Rule baseline + time-window optimization + dynamic replanning |

Git-based operational collection is temporary. It remains unchanged until replacement storage, backfill, dual-write comparison, and cutover validation are ready. Long term, Git will retain only small test fixtures and intentional reference data.

### Implemented today

- Separate Disneyland Park and Disney California Adventure views.
- Attraction, entertainment, operating-hours, and live-status displays.
- Queue-Times and ThemeParks.wiki integrations with local cache fallback.
- Five-minute browser refresh, manual refresh, Leaflet/OpenStreetMap mapping, and built-in coordinate fallback.
- Structured retention of Single Rider data and its relationship to the base attraction.
- Park-hours-aware collection, CSV normalization, canonical attraction mapping, quality checks, and optimizer-ready projections.
- Architecture rules, module ownership, ADRs, an AI context map, governance CI, and migration-focused characterization tests.

### Architecture

The target is a modular monolith in a monorepo, not a collection of premature microservices.

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

| Module | Ownership |
| --- | --- |
| [catalog](modules/catalog/README.md) | Parks, attractions, aliases, access modes, and canonical identities |
| [ingestion](modules/ingestion/README.md) | Third-party adapters, retries, raw payloads, attribution, and source health |
| [observations](modules/observations/README.md) | Normalization, wait/status semantics, quality flags, deduplication, and lineage |
| [forecasting](modules/forecasting/README.md) | Features, baselines, training, inference, evaluation, and model versions |
| [planning](modules/planning/README.md) | Preferences, time windows, walking graph use, route scoring, and replanning |

Applications and shared packages have separate boundaries: [web](apps/web/README.md), [API](apps/api/README.md), [collector worker](workers/collector/README.md), [contracts](packages/contracts/README.md), [domain primitives](packages/domain/README.md), [testkit](packages/testkit/README.md), and [infrastructure](infra/README.md).

### Migration sequence

1. **Governance foundation — complete:** rules, boundaries, ADRs, tests, and CI skeleton.
2. **Characterization baseline — complete:** current collection, parsing, identity, quality, failure, and optimizer behavior.
3. **Extract current modules:** split adapters and pure rules while keeping CLI commands and outputs stable.
4. **Migrate storage:** introduce immutable raw storage and PostgreSQL/time-series persistence with backfill and dual-run comparison.
5. **Introduce product API and PWA:** replace direct browser access to third-party sources with owned APIs.
6. **Add forecasting and planning:** establish reproducible baselines before ML, OR-Tools, and rolling replanning.

See the [migration roadmap](docs/architecture/migration-roadmap.md) for exit criteria.

### Core data rules

- `canonical_attraction_id` is the stable cross-source identity.
- Source IDs are adapter evidence, not cross-module primary keys.
- Persist event timestamps in UTC and retain each park's IANA timezone.
- A closed attraction does not produce a real zero-minute standby observation.
- Standby, Single Rider, virtual queue, and future access modes remain structurally distinct.
- Raw observations are immutable; normalized and derived records retain lineage and producing versions.
- Forecast and route outputs include generation time and model or algorithm version.

### Run locally

Open `index.html`, or serve the static site:

```powershell
python -m http.server 5173
```

Run collection and analysis:

```powershell
node scripts/collect-wait-times.mjs
node scripts/collect-wait-times.mjs --normalize-only
node scripts/update-cache.mjs
node scripts/analyze-wait-times.mjs
node scripts/analyze-wait-times.mjs --no-write
```

Run the characterization suite or all checks:

```powershell
npm run test:characterization
npm run check
```

The characterization tests execute copies of the real CLI entrypoints in temporary directories. They do not call live APIs or modify production data in the repository. See the [test README](tests/characterization/README.md) for the protected behaviors and known legacy semantics.

### Documentation entrypoints

- New development task: read [Project Rules](AGENTS.md) and the [AI Context Map](docs/ai/context-map.md).
- System architecture: read the [Architecture Overview](docs/architecture/overview.md).
- Domain change: read the owning `modules/<name>/README.md` and affected public contracts.
- Durable decision: add or supersede an [ADR](docs/adr/README.md); do not silently rewrite history.
- Current data-quality implementation: read the [V0.5 Data Quality README](docs/v0.5-readme.md).
