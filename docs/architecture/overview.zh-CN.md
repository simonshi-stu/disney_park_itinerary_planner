# 架构总览

## 目标

构建面向主题乐园的智能行程规划产品，把实时状态、历史观测、预测、演出时间窗、步行约束和游客偏好组合成可执行、可动态重算的单园单日行程。

## 产品与验证范围

- 当前产品、开发、自采数据和端到端验证范围仅为加州 Disneyland Park 与 Disney California Adventure。
- 上海、香港、奥兰多、环球影城等只是未来可能性，不是当前实现承诺。
- 领域显式支持多运营商和多园区；当前 itinerary use case 仍是一个 `park_id` 和一个服务日。

## 当前现实

- 根目录和 `src/` 是静态多页面网站。
- 浏览器仍直读第三方 API，并使用本地 JSON fallback。
- `scripts/` 中的 Node.js 脚本负责采集、cache 和质量分析。
- CSV、JSON、cache 和报告暂时存放在 Git。
- GitHub Action 定时采集并提交观测数据。

这些实现必须在替代存储和迁移验证就绪前继续运行。目标目录当前首先表达所有权，不表示代码已经迁移。

## 目标形态

目标是 monorepo 中的模块化单体，不是提前拆分大量微服务：

```text
apps/web -> versioned API contracts
apps/api -> use cases + dependency injection
modules/catalog
modules/ingestion
modules/observations
modules/forecasting
modules/planning
packages/contracts
packages/domain
workers/collector
infra
```

部署进程可以因运行需求分开，但领域数据和规则仍由模块拥有。

## 核心边界

- **Catalog：**运营商、园区、项目、演出、别名、access mode 和 canonical ID。
- **Ingestion：**来源 adapter、重试/限流、raw payload、归因和来源健康。
- **Observations：**规范化、状态语义、质量 flags、去重和数据血缘。
- **Forecasting：**特征、基线、训练、推理、回测和模型版本。
- **Planning：**偏好、步行图、时间窗、可行性、评分和重规划。
- **Web/API：**Web 只负责交互展示；API 负责传输验证、用例协调和依赖注入。

## 技术方向

- Web：TypeScript + Next.js PWA。
- API/ML：Python + FastAPI，算法库隐藏在领域 ports 后面。
- Bootstrap：现有 Node.js 脚本在迁移前保留。
- 存储：PostgreSQL/时序能力 + immutable raw object storage。
- Redis：仅在 cache、session、锁或短期协调确有价值时使用。

## 原则

1. Raw input 不可变且可回放。
2. Canonical identity 与来源无关。
3. 跨模块集成先定义 contract。
4. 领域规则尽量确定性并隔离 I/O。
5. Forecasting 和 planning 必须有基线与 fallback。
6. 当前现实与目标架构分开描述。
