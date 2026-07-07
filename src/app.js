(function () {
  const state = {
    rides: [],
    source: "loading",
    selectedPark: "all",
    selectedStatus: "all",
    sort: "wait-desc",
    search: ""
  };

  const elements = {
    refreshButton: document.querySelector("#refreshButton"),
    lastUpdated: document.querySelector("#lastUpdated"),
    parkSelect: document.querySelector("#parkSelect"),
    statusSelect: document.querySelector("#statusSelect"),
    sortSelect: document.querySelector("#sortSelect"),
    searchInput: document.querySelector("#searchInput"),
    openCount: document.querySelector("#openCount"),
    averageWait: document.querySelector("#averageWait"),
    maxWait: document.querySelector("#maxWait"),
    dataSource: document.querySelector("#dataSource"),
    rideCount: document.querySelector("#rideCount"),
    rideList: document.querySelector("#rideList"),
    parkMap: document.querySelector("#parkMap"),
    eventList: document.querySelector("#eventList"),
    trendChart: document.querySelector("#trendChart"),
    trendNote: document.querySelector("#trendNote")
  };

  function queueTimesUrl(park) {
    return `https://queue-times.com/parks/${park.queueTimesParkId}/queue_times.json`;
  }

  async function fetchParkData(park) {
    const response = await fetch(queueTimesUrl(park), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Queue Times request failed for ${park.name}`);
    }
    return response.json();
  }

  async function loadWaitTimes() {
    elements.refreshButton.disabled = true;
    elements.refreshButton.textContent = "加载中...";

    try {
      const entries = await Promise.all(
        Object.values(PARKS).map(async (park) => {
          const data = await fetchParkData(park);
          return normalizeParkData(park, data);
        })
      );

      state.rides = entries.flat();
      state.source = "Queue Times API";
      saveHistorySnapshot(state.rides);
    } catch (error) {
      console.warn(error);
      state.rides = Object.values(PARKS)
        .map((park) => normalizeParkData(park, SAMPLE_QUEUE_TIMES[park.id]))
        .flat();
      state.source = "示例数据";
    } finally {
      elements.refreshButton.disabled = false;
      elements.refreshButton.textContent = "刷新实时数据";
      elements.lastUpdated.textContent = `最后刷新: ${formatTime(new Date())}`;
      render();
    }
  }

  function normalizeParkData(park, data) {
    const rides = [];
    const lands = Array.isArray(data.lands) ? data.lands : [];
    const rootRides = Array.isArray(data.rides) ? data.rides : [];

    lands.forEach((land, landIndex) => {
      (land.rides || []).forEach((ride, rideIndex) => {
        rides.push(buildRide(park, ride, land.name, landIndex, rideIndex));
      });
    });

    rootRides.forEach((ride, rideIndex) => {
      rides.push(buildRide(park, ride, "Other", lands.length, rideIndex));
    });

    return rides;
  }

  function buildRide(park, ride, land, landIndex, rideIndex) {
    const meta = ATTRACTION_META[ride.name] || estimateLocation(park, landIndex, rideIndex);

    return {
      id: `${park.id}-${ride.id}`,
      parkId: park.id,
      parkName: park.name,
      name: ride.name,
      land,
      isOpen: Boolean(ride.is_open),
      waitTime: Number.isFinite(ride.wait_time) ? ride.wait_time : 0,
      lastUpdated: ride.last_updated,
      lat: meta.lat,
      lon: meta.lon,
      locationSource: ATTRACTION_META[ride.name] ? "curated" : "estimated"
    };
  }

  function estimateLocation(park, landIndex, rideIndex) {
    const bounds = park.bounds;
    const columns = 5;
    const rows = 5;
    const col = (landIndex + rideIndex) % columns;
    const row = (landIndex * 2 + rideIndex) % rows;
    const lonRange = bounds.east - bounds.west;
    const latRange = bounds.north - bounds.south;

    return {
      lat: bounds.north - latRange * ((row + 0.5) / rows),
      lon: bounds.west + lonRange * ((col + 0.5) / columns)
    };
  }

  function getFilteredRides() {
    const search = state.search.trim().toLowerCase();

    return state.rides
      .filter((ride) => state.selectedPark === "all" || ride.parkId === state.selectedPark)
      .filter((ride) => {
        if (state.selectedStatus === "open") return ride.isOpen;
        if (state.selectedStatus === "closed") return !ride.isOpen;
        return true;
      })
      .filter((ride) => !search || ride.name.toLowerCase().includes(search) || ride.land.toLowerCase().includes(search))
      .sort((a, b) => {
        if (state.sort === "wait-asc") return a.waitTime - b.waitTime;
        if (state.sort === "name") return a.name.localeCompare(b.name);
        return b.waitTime - a.waitTime;
      });
  }

  function render() {
    const rides = getFilteredRides();
    renderSummary(rides);
    renderRideList(rides);
    renderMap(rides);
    renderEvents();
    renderTrend();
  }

  function renderSummary(rides) {
    const openRides = rides.filter((ride) => ride.isOpen);
    const totalWait = openRides.reduce((sum, ride) => sum + ride.waitTime, 0);
    const average = openRides.length ? Math.round(totalWait / openRides.length) : 0;
    const maxRide = openRides.reduce((max, ride) => (ride.waitTime > max.waitTime ? ride : max), { waitTime: 0, name: "无" });

    elements.openCount.textContent = `${openRides.length}`;
    elements.averageWait.textContent = `${average} 分钟`;
    elements.maxWait.textContent = maxRide.name === "无" ? "无" : `${maxRide.waitTime} 分钟`;
    elements.dataSource.textContent = state.source;
    elements.rideCount.textContent = `${rides.length} 项`;
  }

  function renderRideList(rides) {
    if (!rides.length) {
      elements.rideList.innerHTML = `<p class="muted">没有符合筛选条件的项目。</p>`;
      return;
    }

    elements.rideList.innerHTML = rides
      .map((ride) => {
        const statusClass = ride.isOpen ? "open" : "closed";
        const statusText = ride.isOpen ? "open" : "closed";
        const wait = ride.isOpen ? `${ride.waitTime} min` : "--";

        return `
          <article class="ride-card">
            <div>
              <p class="ride-name">${escapeHtml(ride.name)}</p>
              <p class="ride-meta">${escapeHtml(ride.parkName)} · ${escapeHtml(ride.land)}</p>
              <span class="status ${statusClass}">${statusText}</span>
            </div>
            <div class="wait-time">${wait}</div>
          </article>
        `;
      })
      .join("");
  }

  function renderMap(rides) {
    const visibleParks = state.selectedPark === "all" ? Object.values(PARKS) : [PARKS[state.selectedPark]];
    const bounds = combineBounds(visibleParks.map((park) => park.bounds));

    const parkLabels = visibleParks
      .map((park) => {
        const center = projectPoint(
          {
            lat: (park.bounds.north + park.bounds.south) / 2,
            lon: (park.bounds.east + park.bounds.west) / 2
          },
          bounds
        );
        return `<span class="map-label" style="left:${center.x}%;top:${center.y}%">${escapeHtml(park.name)}</span>`;
      })
      .join("");

    const markers = rides
      .map((ride) => {
        const point = projectPoint(ride, bounds);
        const intensity = ride.isOpen ? waitIntensity(ride.waitTime) : "closed";
        const note = ride.locationSource === "estimated" ? "估算点位" : "整理点位";
        return `
          <button class="map-marker ${intensity}" style="left:${point.x}%;top:${point.y}%" aria-label="${escapeHtml(ride.name)} ${ride.waitTime}分钟">
            <span>${escapeHtml(ride.name)}<br>${escapeHtml(ride.land)} · ${ride.isOpen ? `${ride.waitTime} min` : "closed"}<br>${note}</span>
          </button>
        `;
      })
      .join("");

    elements.parkMap.innerHTML = parkLabels + markers;
  }

  function combineBounds(boundsList) {
    return boundsList.reduce(
      (acc, bounds) => ({
        north: Math.max(acc.north, bounds.north),
        south: Math.min(acc.south, bounds.south),
        west: Math.min(acc.west, bounds.west),
        east: Math.max(acc.east, bounds.east)
      }),
      { north: -Infinity, south: Infinity, west: Infinity, east: -Infinity }
    );
  }

  function projectPoint(point, bounds) {
    const x = ((point.lon - bounds.west) / (bounds.east - bounds.west)) * 100;
    const y = ((bounds.north - point.lat) / (bounds.north - bounds.south)) * 100;

    return {
      x: clamp(x, 4, 96),
      y: clamp(y, 6, 94)
    };
  }

  function waitIntensity(waitTime) {
    if (waitTime >= 60) return "high";
    if (waitTime >= 30) return "medium";
    return "low";
  }

  function renderEvents() {
    const events = MANUAL_EVENTS.filter((event) => state.selectedPark === "all" || event.park === state.selectedPark);

    elements.eventList.innerHTML = events
      .map(
        (event) => `
          <article class="event-card">
            <h3>${escapeHtml(event.title)}</h3>
            <p>${escapeHtml(PARKS[event.park].name)} · ${escapeHtml(event.type)}</p>
            <div class="event-times">
              ${event.times.map((time) => `<span>${escapeHtml(time)}</span>`).join("")}
            </div>
            <p>${escapeHtml(event.note)}</p>
          </article>
        `
      )
      .join("");
  }

  function saveHistorySnapshot(rides) {
    const openRides = rides.filter((ride) => ride.isOpen);
    if (!openRides.length) return;

    const snapshot = {
      timestamp: new Date().toISOString(),
      park: "all",
      averageWait: Math.round(openRides.reduce((sum, ride) => sum + ride.waitTime, 0) / openRides.length),
      maxWait: Math.max(...openRides.map((ride) => ride.waitTime))
    };

    const history = readHistory();
    history.push(snapshot);
    localStorage.setItem("disneyPlannerHistory", JSON.stringify(history.slice(-240)));
  }

  function readHistory() {
    try {
      return JSON.parse(localStorage.getItem("disneyPlannerHistory") || "[]");
    } catch (error) {
      return [];
    }
  }

  function renderTrend() {
    const history = readHistory();
    const seededHistory = history.length ? history : buildSeedTrend();
    const byHour = groupHistoryByHour(seededHistory);
    const maxAverage = Math.max(...byHour.map((item) => item.average), 1);

    elements.trendChart.innerHTML = byHour
      .map((item) => {
        const height = Math.max(8, (item.average / maxAverage) * 100);
        return `
          <div class="bar">
            <div class="bar-fill" style="height:${height}%"></div>
            <small>${item.hour}:00<br>${item.average}m</small>
          </div>
        `;
      })
      .join("");

    elements.trendNote.textContent = history.length
      ? `已记录 ${history.length} 条本地快照。后续 Version 1 会把这些快照改为后端定时入库，才能训练 forecasting 模型。`
      : "当前还没有真实历史快照，趋势图使用示例曲线。点击刷新并保持页面使用，会开始在本浏览器记录数据。";
  }

  function groupHistoryByHour(history) {
    const buckets = new Map();

    history.forEach((item) => {
      const hour = new Date(item.timestamp).getHours();
      const values = buckets.get(hour) || [];
      values.push(item.averageWait);
      buckets.set(hour, values);
    });

    return Array.from(buckets.entries())
      .map(([hour, values]) => ({
        hour: String(hour).padStart(2, "0"),
        average: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      }))
      .sort((a, b) => Number(a.hour) - Number(b.hour))
      .slice(-12);
  }

  function buildSeedTrend() {
    const now = new Date();
    const values = [18, 24, 31, 38, 48, 57, 62, 54, 46, 39, 34, 28];

    return values.map((averageWait, index) => {
      const timestamp = new Date(now);
      timestamp.setHours(now.getHours() - (values.length - 1 - index));
      timestamp.setMinutes(0, 0, 0);
      return {
        timestamp: timestamp.toISOString(),
        averageWait
      };
    });
  }

  function bindEvents() {
    elements.refreshButton.addEventListener("click", loadWaitTimes);
    elements.parkSelect.addEventListener("change", (event) => {
      state.selectedPark = event.target.value;
      render();
    });
    elements.statusSelect.addEventListener("change", (event) => {
      state.selectedStatus = event.target.value;
      render();
    });
    elements.sortSelect.addEventListener("change", (event) => {
      state.sort = event.target.value;
      render();
    });
    elements.searchInput.addEventListener("input", (event) => {
      state.search = event.target.value;
      render();
    });
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(date);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  bindEvents();
  loadWaitTimes();
})();
