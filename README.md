# Disney Park Itinerary Planner

[Version 0.5 Data Quality README](docs/v0.5-readme.md)

[中文版本](#chinese-version) | [English Version](#english-version)

<a id="chinese-version"></a>
## 中文版本

[Jump to English Version](#english-version)

这是一个面向主题乐园游客的园区规划项目。当前开发先从 Disneyland Resort 开始，重点是把实时排队时间、项目状态、演出时间、园区地图和历史等待时间采集整理清楚。

项目仍在持续制作中，当前版本主要集中在基础数据展示和等待时间采集。

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

GitHub Actions 配置在 `.github/workflows/collect-wait-times.yml`。当前采集使用双触发方式：

- GitHub `schedule`: 尝试每 15 分钟自动运行一次。
- `repository_dispatch`: 给外部 cron 服务触发使用，适合用 cron-job.org 或 Cloudflare Workers Cron 做更稳定的定时触发。
- 采集脚本会按每个园区自己的 ThemeParks.wiki park hours 判断是否采集。
- 如果两个园区都不在采集窗口内，脚本不会写入 CSV，也不会更新 `latest_snapshot.json`。

外部 cron 可以 POST 到：

```text
https://api.github.com/repos/simonshi-stu/disney_park_itinerary_planner/dispatches
```

请求 body：

```json
{"event_type":"collect-wait-times"}
```

请求 header 需要带 GitHub token：

```text
Authorization: Bearer YOUR_GITHUB_TOKEN
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

采集脚本默认会跳过 5 分钟内的重复 snapshot，避免手动触发和定时触发撞在一起时写入重复数据。默认只在开园前 30 分钟到闭园后 60 分钟之间采集该园区；如果 Disneyland 还开着但 DCA 已经关闭，就只采 Disneyland。

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
│       ├── latest_snapshot.json
│       └── wait_times_YYYY-MM-DD.csv
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

This project is still in progress. The current version focuses on the data display layer and wait-time collection.

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

GitHub Actions is configured in `.github/workflows/collect-wait-times.yml`. The current setup uses two scheduled paths:

- GitHub `schedule`: attempts to run the collector every 15 minutes.
- `repository_dispatch`: allows an external cron service, such as cron-job.org or Cloudflare Workers Cron, to trigger the collector more reliably.
- The collector checks each park's own ThemeParks.wiki park hours before writing data.
- If both parks are outside their collection windows, the script does not write CSV data or update `latest_snapshot.json`.

An external cron service can POST to:

```text
https://api.github.com/repos/simonshi-stu/disney_park_itinerary_planner/dispatches
```

Request body:

```json
{"event_type":"collect-wait-times"}
```

Required headers:

```text
Authorization: Bearer YOUR_GITHUB_TOKEN
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

The collector skips snapshots that are less than 5 minutes apart, which prevents duplicate rows when manual and scheduled triggers happen close together. By default, a park is collected from 30 minutes before opening until 60 minutes after closing. If Disneyland is still open but DCA is already closed, only Disneyland is collected.

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
