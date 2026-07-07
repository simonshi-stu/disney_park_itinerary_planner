# Disney Park Itinerary Planner

Chinese documentation is available in [README.md](README.md).

This project is a Disneyland Resort planning prototype. Version 0 focuses on accurate live data display, entertainment schedules, interactive maps, and wait-time data collection before moving into forecasting and itinerary recommendation.

## Timezone Standard

This project uses California time as the single standard timezone:

```text
America/Los_Angeles
```

Why:

- Disneyland Park and Disney California Adventure Park are both located in Anaheim, California.
- ThemeParks.wiki and Queue Times may return UTC timestamps or ISO datetime strings.
- Showtimes, park hours, and schedule filtering must be normalized to `America/Los_Angeles`; otherwise events can appear at misleading times such as `00:30` or `23:30`.

Current implementation:

- Both parks in `src/data.js` use `timezone: "America/Los_Angeles"`.
- `src/app.js` parses dates through `formatClock()`, `getDateInZone()`, and `getParkDate()`.
- `schedule.html` only displays valid same-day entertainment showtimes in California time.
- Wait-time CSV snapshots keep `snapshot_utc` in UTC for forecasting and cross-system analysis; display logic can convert to California time.

## Pages

- `index.html`: Project home and roadmap.
- `attractions.html`: Park -> Attractions / Entertainment -> status, wait time, and showtimes.
- `schedule.html`: Entertainment-only schedule with separate park hours.
- `map.html`: Leaflet + OpenStreetMap interactive map with coordinate-based markers.

## Data Sources

### Queue Times API

Used for live wait times:

```text
Disneyland Park:
https://queue-times.com/parks/16/queue_times.json

Disney California Adventure Park:
https://queue-times.com/parks/17/queue_times.json
```

Queue Times attribution is displayed in the UI.

### ThemeParks.wiki API

Used for full entities, live status, showtimes, and schedules:

```text
children: full entity list
live: live status / queues / showtimes
schedule: park hours and scheduled items
```

## Major Changes Implemented

### 1. Multi-page Website

The project is no longer a single-page website. It now has a home page, attractions page, schedule page, and map page.

### 2. Disneyland and DCA Separated

Confirmed park ids:

```text
16 = Disneyland Park
17 = Disney California Adventure Park
```

Users can view each park separately or compare both parks.

### 3. Real Interactive Map

The map page now uses Leaflet + OpenStreetMap. Markers are bound to latitude/longitude coordinates instead of being fixed dots over a static image.

To avoid misleading data:

- Only trusted coordinates are rendered on the map.
- Estimated coordinates are not shown on the map.
- Items without trusted coordinates still appear on `attractions.html`.

### 4. Schedule Fixes

`schedule.html` only shows entertainment items, such as:

- shows
- parades
- fireworks
- nighttime spectaculars
- character or seasonal entertainment

Regular attractions are not shown on the schedule page.  
Showtimes are parsed in `America/Los_Angeles` and filtered against the selected park's operating hours with a small buffer.

### 5. Single Rider Information

If the API includes entries like:

```text
Radiator Springs Racers Single Rider
Millennium Falcon: Smugglers Run Single Rider
```

the page merges them under the main attraction and displays a `Single Rider` badge instead of treating them as separate attractions.

### 6. Auto Refresh

The frontend:

- refreshes live data every 5 minutes;
- refreshes when the user returns to the browser tab;
- shows latest refresh status in the bottom-right status pill.

## ThemeParks.wiki Local JSON Cache

Purpose: store full ThemeParks.wiki `children`, `live`, and `schedule` responses locally as fallback data and for debugging.

Run:

```powershell
node scripts/update-cache.mjs
```

Output:

```text
src/cache/themeparks/disneyland.children.json
src/cache/themeparks/disneyland.live.json
src/cache/themeparks/disneyland.schedule.json
src/cache/themeparks/dca.children.json
src/cache/themeparks/dca.live.json
src/cache/themeparks/dca.schedule.json
src/cache/themeparks/cache-manifest.json
```

If Codex sandbox returns `fetch failed` or `EACCES`, command-line network access is blocked. Run the command from your local terminal instead.

## Wait-Time Data Collection

Purpose: save live wait-time snapshots for future forecasting.

Run one snapshot:

```powershell
node scripts/collect-wait-times.mjs
```

Output:

```text
data/wait_times/wait_times_YYYY-MM-DD.csv
data/wait_times/latest_snapshot.json
```

The CSV can be opened directly in Excel and can also be consumed by Python, R, or ML pipelines.
CSV files are written with a UTF-8 BOM so Excel can open names with special characters correctly. The `YYYY-MM-DD` filename date uses `America/Los_Angeles`; each row keeps both `snapshot_utc` and `snapshot_park_datetime` for machine analysis and manual review.

To normalize existing CSV files with the current encoding and local-time columns, run:

```powershell
node scripts/collect-wait-times.mjs --normalize-only
```

Recommended collection volume:

- Minimum useful baseline: 4 weeks, every 15 minutes.
- Better baseline: 60-90 days, every 5-15 minutes.
- Strong seasonal model: 6-12 months, covering weekends, holidays, summer, Halloween, and Christmas.

At 15-minute intervals, each attraction gets about 96 observations per day. At 5-minute intervals, each attraction gets about 288 observations per day.

## Automatic Cloud Collection

The repo includes:

```text
.github/workflows/collect-wait-times.yml
```

It runs `scripts/collect-wait-times.mjs` every 15 minutes and commits updated CSV files to:

```text
data/wait_times/
```

Recommended cloud options:

- GitHub Actions + CSV: best for the current portfolio stage, simple and easy to show.
- Google Drive / Google Sheets: useful for manual inspection, but OAuth setup is more involved.
- Supabase / PostgreSQL: best long-term option for forecasting and query analysis.
- S3 / Google Cloud Storage: good for large raw file storage, but usually needs a database for analysis.

For now, start with GitHub Actions + CSV. Move to Supabase/PostgreSQL once the dataset spans several months.

## Run Locally

Open:

```text
index.html
```

Or run a local static server:

```powershell
python -m http.server 5173
```

Then visit:

```text
http://localhost:5173
```

## Key File Structure

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
