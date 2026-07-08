# Disney Park Itinerary Planner

[中文版本](#chinese-version) | [English Version](#english-version)

<a id="chinese-version"></a>
## 中文版本

[Jump to English Version](#english-version)

这是一个面向 Disneyland Resort 游客的园区数据看板项目。当前版本的重点是把实时排队时间、项目状态、演出时间、园区地图和历史等待时间采集整理清楚，先完成稳定的数据展示和数据保存。

### 当前实现

- 多页面结构：包含首页、项目与演出、表演时间表、园区地图。
- 支持 Disneyland Park 和 Disney California Adventure Park 分开展示。
- 实时等待时间来自 Queue Times API。
- 项目、演出、开放时间和部分 live data 来自 ThemeParks.wiki API。
- 前端会优先读取实时 API，失败时使用本地 JSON cache 作为 fallback。
- 页面会每 5 分钟自动刷新一次实时数据，也支持手动刷新。
- 所有园区时间统一按 `America/Los_Angeles` 处理。
- 地图使用 Leaflet + OpenStreetMap，只展示已有可信经纬度的项目点位。
- 表演时间页只展示 entertainment 类型内容，例如表演、巡游、烟花和夜间演出。
- Single Rider 项目会合并到主项目下展示，不单独混在普通项目列表里。
- 等待时间数据会保存为 CSV，方便后续分析。
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

或启动一个本地静态服务器：

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

This is a park data dashboard project for Disneyland Resort visitors. The current version focuses on showing live wait times, attraction status, entertainment schedules, park maps, and collected wait-time history in a clear and reusable way.

### Current Features

- Multi-page site with home, attractions, schedule, and map pages.
- Separate views for Disneyland Park and Disney California Adventure Park.
- Live wait times from the Queue Times API.
- Attraction, entertainment, park-hours, and live-status data from the ThemeParks.wiki API.
- The frontend uses live APIs first and falls back to local JSON cache when needed.
- Live data refreshes automatically every 5 minutes, with a manual refresh option.
- Park times are normalized to `America/Los_Angeles`.
- The map uses Leaflet + OpenStreetMap and only shows items with trusted coordinates.
- The schedule page only shows entertainment items such as shows, parades, fireworks, and nighttime spectaculars.
- Single Rider entries are merged into their main attraction instead of appearing as separate items.
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
