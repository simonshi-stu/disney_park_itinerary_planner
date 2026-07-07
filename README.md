# 迪士尼园区规划项目

英文版文档见 [README_EN.md](README_EN.md)。

这是一个面向 Disneyland Resort 游客的园区规划项目。当前 Version 0 的重点不是马上做推荐路线，而是先把实时数据、演出时间、园区地图、历史排队数据采集这些基础能力打稳，为后续 forecasting 和 itinerary recommendation 做准备。

## 时区标准

本项目统一使用美国加州时区：

```text
America/Los_Angeles
```

原因：

- Disneyland Park 和 Disney California Adventure Park 都位于 California, Anaheim。
- ThemeParks.wiki 和 Queue Times 返回的数据可能包含 UTC 时间或 ISO 时间戳。
- 页面展示、演出时间过滤、园区开放时间判断，都必须统一转换成 `America/Los_Angeles`，否则会出现类似 `00:30`、`23:30` 这种看起来不合理的演出时间。

当前实现：

- `src/data.js` 中两个园区都配置了 `timezone: "America/Los_Angeles"`。
- `src/app.js` 中的 `formatClock()`、`getDateInZone()`、`getParkDate()` 会按园区时区解析时间。
- `schedule.html` 只展示当天、加州时区下有效的 entertainment showtimes。
- 等待时间采集 CSV 中的 `snapshot_utc` 保留 UTC，便于机器学习和跨系统分析；展示时再转换成加州时间。

## 当前页面

- `index.html`: 项目首页和版本路线。
- `attractions.html`: 按“园区 -> Attractions / Entertainment -> 状态 / 排队时间 / 演出时间”展示。
- `schedule.html`: 只展示当天表演、巡游、烟花等 entertainment 时间，并单独展示园区开放时间。
- `map.html`: 使用 Leaflet + OpenStreetMap 的真实交互地图，marker 绑定经纬度。

## 数据源

### Queue Times API

用于实时排队时间：

```text
Disneyland Park:
https://queue-times.com/parks/16/queue_times.json

Disney California Adventure Park:
https://queue-times.com/parks/17/queue_times.json
```

页面中已展示 Queue Times attribution。

### ThemeParks.wiki API

用于完整项目、演出、live status 和 schedule：

```text
children: 完整 entity 列表
live: live status / queues / showtimes
schedule: 园区开放时间和 scheduled items
```

## 已完成的重要修改

### 1. 多页面结构

项目不再是 single page website，而是拆成首页、项目与演出、时间表、地图页。

### 2. Disneyland 和 DCA 分开处理

两个园区的 park id 已确认：

```text
16 = Disneyland Park
17 = Disney California Adventure Park
```

页面可以分园区查看，也可以选择全部园区对比。

### 3. 真实地图

地图页改成 Leaflet + OpenStreetMap。项目 marker 使用经纬度坐标，不再是静态地图上贴固定圆点。

为避免误导：

- 有可信经纬度的项目才显示在地图上。
- 估算点位不会画到地图上。
- 没有可信坐标的项目仍会在 `attractions.html` 中展示。

### 4. 时间表修正

`schedule.html` 只展示 entertainment items，例如：

- 表演
- 巡游
- 烟花
- 夜间演出
- Character / seasonal entertainment

普通游玩项目不会出现在时间表里。<br>
演出时间会按 `America/Los_Angeles` 解析，并过滤掉明显不在当天或不在园区开放时间附近的 showtimes。

### 5. Single Rider 信息

如果 API 中出现类似：

```text
Radiator Springs Racers Single Rider
Millennium Falcon: Smugglers Run Single Rider
```

页面会把它合并到主项目下，用 `Single Rider` badge 显示，而不是当作独立项目混在列表里。

### 6. 自动刷新

前端页面会：

- 每 5 分钟自动刷新一次实时数据。
- 用户切回浏览器 tab 时刷新一次。
- 右下角显示最后更新时间和自动刷新状态。

## ThemeParks.wiki 本地 JSON Cache

目的：把 ThemeParks.wiki 的完整 `children`、`live`、`schedule` 返回保存到本地，作为 API 失败时的 fallback，也方便调试数据结构。

运行：

```powershell
node scripts/update-cache.mjs
```

输出：

```text
src/cache/themeparks/disneyland.children.json
src/cache/themeparks/disneyland.live.json
src/cache/themeparks/disneyland.schedule.json
src/cache/themeparks/dca.children.json
src/cache/themeparks/dca.live.json
src/cache/themeparks/dca.schedule.json
src/cache/themeparks/cache-manifest.json
```

如果在 Codex 沙盒里出现 `fetch failed` 或 `EACCES`，说明命令行联网被限制。把项目拉到你本机正常网络环境后再运行即可。

## 排队时间数据采集

目的：保存实时 wait time snapshots，为未来 forecasting 训练模型。

运行一次采集：

```powershell
node scripts/collect-wait-times.mjs
```

输出：

```text
data/wait_times/wait_times_YYYY-MM-DD.csv
data/wait_times/latest_snapshot.json
```

CSV 可以直接用 Excel 打开，也可以被 Python、R、机器学习 pipeline 读取。
CSV 使用 UTF-8 BOM 写入，避免 Excel 直接打开时出现特殊符号乱码。文件名里的 `YYYY-MM-DD` 按 `America/Los_Angeles` 日期归档；表内同时保留 `snapshot_utc` 和 `snapshot_park_datetime`，方便机器分析和人工查看。

如果需要整理已有 CSV 的编码和本地时间字段，可以运行：

```powershell
node scripts/collect-wait-times.mjs --normalize-only
```

建议采集量：

- 最低可用 baseline: 4 周，每 15 分钟一次。
- 更可靠 baseline: 60-90 天，每 5-15 分钟一次。
- 更强的季节性模型: 6-12 个月，覆盖周末、节假日、暑假、Halloween、Christmas。

按 15 分钟采集，每个项目每天约 96 条记录；按 5 分钟采集，每个项目每天约 288 条记录。

## 云端自动采集

项目已加入 GitHub Actions：

```text
.github/workflows/collect-wait-times.yml
```

它会每 15 分钟运行一次 `scripts/collect-wait-times.mjs`，并把 CSV commit 回 GitHub repo 的：

```text
data/wait_times/
```

推荐云端方案：

- GitHub Actions + CSV: 最适合当前 portfolio 阶段，简单、免费、容易展示。
- Google Drive / Google Sheets: 适合人工查看，但 OAuth 配置更麻烦。
- Supabase / PostgreSQL: 最适合长期 forecasting 和查询分析。
- S3 / Google Cloud Storage: 适合保存大量原始文件，但分析时通常还需要数据库。

当前阶段建议先用 GitHub Actions + CSV。等数据超过几个月，再迁移到 Supabase/PostgreSQL。

## 本地运行

直接打开：

```text
index.html
```

或者启动本地静态服务器：

```powershell
python -m http.server 5173
```

然后访问：

```text
http://localhost:5173
```

## 关键文件结构

```text
.
├── .github/workflows/collect-wait-times.yml
├── attractions.html
├── index.html
├── map.html
├── schedule.html
├── scripts
│   ├── collect-wait-times.mjs
│   └── update-cache.mjs
├── src
│   ├── app.js
│   ├── data.js
│   ├── styles.css
│   └── cache/themeparks/
└── data/wait_times/
```
