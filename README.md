# 迪士尼园区规划项目

这是一个面向第一次或低频前往迪士尼游客的园区规划项目。长期目标不是复制官方 App，而是把“实时排队、未来等待时间预测、路线推荐、个人偏好”整合成一个更轻量、更决策友好的工具。

## 项目总 Outline

### Version 0: 数据看板版

目标是先把公开数据接入并展示出来，不急着做推荐算法。

- 实时 wait time board: 展示 Disneyland / Disney California Adventure 各项目当前排队时间。
- 项目状态: 标记 open / closed / no data。
- 园区地图点位: 把项目按园区位置可视化，帮助用户理解空间分布。
- 表演和烟花时间: 先用手动整理数据展示，后续接入更完整 schedule 数据。
- 历史排队趋势: 先在浏览器本地记录刷新快照，形成按小时的趋势图；后续升级为后端定时采集。

### Version 1: 数据采集与存储版

目标是把实时数据变成可训练数据。

- 后端定时任务每 5 分钟抓取 wait times。
- 数据库存储 wait time、项目状态、时间、星期、节假日、天气等特征。
- 建立数据清洗和特征工程流程。
- 输出基础分析页面，例如每个项目的高峰时段、平均等待时间、异常关闭情况。

### Version 2: Forecasting 预测版

目标是预测未来 30 分钟到数小时的排队时间。

- 先做 baseline: rolling average、weekday/hour average。
- 再做机器学习模型: XGBoost / LightGBM / Prophet / LSTM 可逐步尝试。
- 输出每个项目未来等待时间曲线。
- 用误差指标评估模型，例如 MAE、RMSE。

### Version 3: Route Recommendation 路线推荐版

目标是从“看数据”升级到“帮用户做决定”。

- 用户输入偏好: 必玩项目、刺激程度、是否带小孩、是否看烟花、是否接受长距离步行。
- 约束条件: 入园时间、离园时间、餐饮、表演、项目开放状态。
- 推荐路线: 综合等待时间、步行时间、项目优先级，生成 itinerary。
- 支持动态重排: 某项目突然关闭或等待时间变高时重新规划。

### Version 4: 产品化 Portfolio 版

目标是成为可以展示给招聘/作品集的完整项目。

- 前端: React / Next.js。
- 后端: FastAPI / Node.js。
- 数据库: PostgreSQL + TimescaleDB 或 Supabase。
- 地图: Mapbox / Leaflet。
- 模型服务: 独立 forecasting API。
- 部署: Vercel + Render/Fly.io + scheduled job。

## 当前已完成: Version 0 静态数据看板

当前版本是一个无构建依赖的前端原型，直接打开 `index.html` 即可运行。

### 数据源

- Queue Times API: `https://queue-times.com/parks/16/queue_times.json` 和 `https://queue-times.com/parks/17/queue_times.json`
- Queue Times 官方要求在产品中展示 attribution，本项目页面底部已加入 `Powered by Queue-Times.com`。
- ThemeParks.wiki schedule endpoint 已预留配置位；若接口或网络不可用，页面会显示手动维护的演出/烟花示例数据。

### 文件结构

```text
.
├── index.html
├── README.md
└── src
    ├── app.js
    ├── data.js
    └── styles.css
```

## 如何运行

直接用浏览器打开 `index.html`。

也可以使用本地静态服务器：

```powershell
python -m http.server 5173
```

然后访问 `http://localhost:5173`。

如果本机没有 Python，可以直接双击 `index.html`，页面仍然可以展示示例数据，并在浏览器允许时请求实时接口。
