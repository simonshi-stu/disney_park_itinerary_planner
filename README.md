# Disney Park Itinerary Planner

[中文版本](#chinese-version) | [English Version](#english-version)

<a id="chinese-version"></a>
## 中文版本

[Jump to English Version](#english-version)

这是一个面向主题乐园游客的园区规划项目。当前开发先从 Disneyland Resort 开始，重点是把实时排队时间、项目状态、演出时间、园区地图和历史等待时间采集整理清楚。

### Project Outline

- Version 0: 数据看板版<br>
  展示实时等待时间、项目状态、演出时间、地图点位，并保存等待时间历史数据。
- Version 1: 数据整理版<br>
  整理不同数据源里的项目 ID、园区、演出、开放时间和历史等待时间，形成更稳定的数据结构。
- Version 2: 等待时间预测版<br>
  基于历史等待时间和时间特征，预测后续时间段的排队变化。
- Version 3: 行程规划版<br>
  根据用户选择的项目、演出、时间限制和偏好，生成一天的游玩顺序。

当前进度：**Version 0 数据看板版**。

### 当前实现

- 多页面结构：`index.html`、`attractions.html`、`schedule.html`、`map.html`。
- 支持 Disneyland Park 和 Disney California Adventure Park 分开展示。
- 实时等待时间来自 Queue Times API。
- 项目、演出、开放时间和部分 live data 来自 ThemeParks.wiki API。
- 前端优先读取实时 API，失败时使用本地 JSON cache 作为 fallback。
- 页面每 5 分钟自动刷新一次实时数据，也支持手动刷新。
- 所有园区时间统一按 `America/Los_Angeles` 处理。
- 地图使用 Leaflet + OpenStreetMap，并增加了内置坐标地图 fallback。
- 地图 marker 会按等待时间分颜色显示，右侧列表可以点击并定位到地图项目。
- 表演时间页只展示 entertainment 类型内容，例如表演、巡游、烟花和夜间演出。
- Single Rider 项目会合并到主项目下展示。
- 等待时间数据保存为 CSV，方便后续分析。
- CSV 使用 UTF-8 BOM 写入，Excel 直接打开时不会因为特殊符号乱码。

### 数据采集

手动采集一次等待时间：

```powershell
node scripts/collect-wait-times.mjs
```

整理已有等待时间 CSV：

```powershell
node scripts/collect-wait-times.mjs --normalize-only
```

更新 ThemeParks.wiki 本地 cache：

```powershell
node scripts/update-cache.mjs
```

GitHub Actions 配置在 `.github/workflows/collect-wait-times.yml`，当前设置为每 15 分钟运行一次等待时间采集脚本，并把更新后的 CSV 和 `latest_snapshot.json` commit 回仓库。

### 本地运行

直接打开：

```text
index.html
```

或启动本地静态服务器：

```powershell
python -m http.server 5173
```

然后访问：

```text
http://localhost:5173
```

### 文件结构

```text
.
├── .github/workflows/
│   └── collect-wait-times.yml
├── data/
│   └── wait_times/
├── scripts/
│   ├── collect-wait-times.mjs
│   └── update-cache.mjs
├── src/
│   ├── app.js
│   ├── data.js
│   ├── styles.css
│   └── cache/themeparks/
├── attractions.html
├── index.html
├── map.html
├── schedule.html
└── README.md
```

<a id="english-version"></a>
## English Version

[返回中文版本](#chinese-version)

This is a theme-park itinerary planning project. The current implementation starts with Disneyland Resort and focuses on organizing live wait times, attraction status, entertainment schedules, maps, and collected wait-time history.

### Project Outline

- Version 0: Data dashboard<br>
  Show live wait times, attraction status, entertainment schedules, map locations, and saved wait-time history.
- Version 1: Data organization<br>
  Normalize attraction IDs, parks, entertainment, park hours, and historical wait-time data across different data sources.
- Version 2: Wait-time forecasting<br>
  Forecast future wait-time changes based on historical snapshots and time-based features.
- Version 3: Itinerary planning<br>
  Generate a one-day park plan based on selected attractions, shows, time limits, and user preferences.

Current progress: **Version 0 data dashboard**.

### Current Features

- Multi-page site: `index.html`, `attractions.html`, `schedule.html`, and `map.html`.
- Separate views for Disneyland Park and Disney California Adventure Park.
- Live wait times from the Queue Times API.
- Attraction, entertainment, park-hours, and live-status data from the ThemeParks.wiki API.
- The frontend uses live APIs first and falls back to local JSON cache when needed.
- Live data refreshes automatically every 5 minutes, with a manual refresh option.
- Park times are normalized to `America/Los_Angeles`.
- The map uses Leaflet + OpenStreetMap, with a built-in coordinate-map fallback.
- Map markers are color-coded by wait time, and the right-side list can focus the matching map item.
- The schedule page only shows entertainment items such as shows, parades, fireworks, and nighttime spectaculars.
- Single Rider entries are merged into their main attraction.
- Wait-time snapshots are saved as CSV for later analysis.
- CSV files are written with a UTF-8 BOM so Excel can open names with special characters correctly.

### Data Collection

Collect one wait-time snapshot:

```powershell
node scripts/collect-wait-times.mjs
```

Normalize existing wait-time CSV files:

```powershell
node scripts/collect-wait-times.mjs --normalize-only
```

Update the local ThemeParks.wiki cache:

```powershell
node scripts/update-cache.mjs
```

GitHub Actions is configured in `.github/workflows/collect-wait-times.yml`. It currently runs the wait-time collection script every 15 minutes and commits the updated CSV files and `latest_snapshot.json` back to the repository.

### Local Run

Open:

```text
index.html
```

Or start a local static server:

```powershell
python -m http.server 5173
```

Then visit:

```text
http://localhost:5173
```

### File Structure

```text
.
├── .github/workflows/
│   └── collect-wait-times.yml
├── data/
│   └── wait_times/
├── scripts/
│   ├── collect-wait-times.mjs
│   └── update-cache.mjs
├── src/
│   ├── app.js
│   ├── data.js
│   ├── styles.css
│   └── cache/themeparks/
├── attractions.html
├── index.html
├── map.html
├── schedule.html
└── README.md
```
