(function () {
  const AUTO_REFRESH_MS = 5 * 60 * 1000;
  const CACHE_PREFIX = "disneyPlanner.themeparks.";
  const LEAFLET_JS_URLS = [
    "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  ];
  const LEAFLET_CSS_URLS = [
    "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  ];

  const state = {
    items: [],
    parkHours: {},
    selectedPark: "all",
    selectedType: "all",
    selectedStatus: "all",
    search: "",
    sources: {},
    lastUpdated: null,
    isRefreshing: false,
    leafletReady: false
  };

  const page = document.body.dataset.page || "home";
  const elements = {
    parkSelect: document.querySelector("#parkSelect"),
    typeSelect: document.querySelector("#typeSelect"),
    statusSelect: document.querySelector("#statusSelect"),
    searchInput: document.querySelector("#searchInput"),
    openCount: document.querySelector("#openCount"),
    averageWait: document.querySelector("#averageWait"),
    maxWait: document.querySelector("#maxWait"),
    dataSource: document.querySelector("#dataSource"),
    catalogRoot: document.querySelector("#catalogRoot"),
    scheduleRoot: document.querySelector("#scheduleRoot"),
    parkHoursRoot: document.querySelector("#parkHoursRoot"),
    mapList: document.querySelector("#mapList"),
    leafletMap: document.querySelector("#leafletMap"),
    mapFallback: document.querySelector("#mapFallback")
  };

  const ATTRACTION_TYPES = new Set(["ATTRACTION"]);
  const ENTERTAINMENT_TYPES = new Set(["SHOW", "ENTERTAINMENT", "PARADE", "NIGHTTIME_SPECTACULAR", "CHARACTER"]);

  let leafletMap = null;
  let markerLayer = null;
  let refreshTimer = null;

  init();

  async function init() {
    bindControls();
    injectRefreshStatus();
    if (page === "map") {
      state.leafletReady = await loadLeafletAssets();
    }
    await refreshData();
    startAutoRefresh();
  }

  function bindControls() {
    if (elements.parkSelect) {
      state.selectedPark = elements.parkSelect.value;
      elements.parkSelect.addEventListener("change", (event) => {
        state.selectedPark = event.target.value;
        render();
      });
    }

    if (elements.typeSelect) {
      state.selectedType = elements.typeSelect.value;
      elements.typeSelect.addEventListener("change", (event) => {
        state.selectedType = event.target.value;
        render();
      });
    }

    if (elements.statusSelect) {
      state.selectedStatus = elements.statusSelect.value;
      elements.statusSelect.addEventListener("change", (event) => {
        state.selectedStatus = event.target.value;
        render();
      });
    }

    if (elements.searchInput) {
      elements.searchInput.addEventListener("input", (event) => {
        state.search = event.target.value;
        render();
      });
    }

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshData();
    });
  }

  function injectRefreshStatus() {
    const status = document.createElement("div");
    status.className = "refresh-status";
    status.innerHTML = `
      <span id="refreshText">Auto refresh is starting</span>
      <button id="manualRefreshButton" type="button">Refresh now</button>
    `;
    document.body.appendChild(status);
    document.querySelector("#manualRefreshButton").addEventListener("click", () => refreshData());
  }

  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => refreshData({ silent: true }), AUTO_REFRESH_MS);
  }

  async function refreshData(options = {}) {
    if (state.isRefreshing) return;
    state.isRefreshing = true;
    updateRefreshStatus("Updating data");

    const previousSignature = createDataSignature(state.items);
    const results = await Promise.all(Object.values(PARKS).map(loadParkData));

    state.items = results.flatMap((result) => result.items);
    state.parkHours = Object.fromEntries(results.map((result) => [result.park.id, result.parkHours]));
    state.sources = Object.fromEntries(results.map((result) => [result.park.id, result.source]));
    state.lastUpdated = new Date();
    state.isRefreshing = false;

    render();

    const nextSignature = createDataSignature(state.items);
    const changed = Boolean(previousSignature && previousSignature !== nextSignature);
    updateRefreshStatus(changed ? "Data changed and refreshed" : "Auto refresh is on");

    if (!options.silent && changed) {
      console.info("Park data changed since last refresh.");
    }
  }

  async function loadParkData(park) {
    const sourceParts = [];
    let queueItems = [];
    let wikiItems = [];
    let parkHours = park.fallbackHours || [];

    try {
      const queueData = await fetchJson(`https://queue-times.com/parks/${park.queueTimesParkId}/queue_times.json`);
      queueItems = normalizeQueueData(park, queueData);
      sourceParts.push("Queue Times API");
    } catch (error) {
      console.warn(error);
      queueItems = normalizeQueueData(park, SAMPLE_QUEUE_TIMES[park.id]).map((item) => ({ ...item, source: "Queue Times sample data" }));
      sourceParts.push("Queue Times sample data");
    }

    try {
      const [childrenData, liveData, scheduleData] = await Promise.all([
        fetchThemeParksJson(park, "children"),
        fetchThemeParksJson(park, "live"),
        fetchThemeParksJson(park, "schedule")
      ]);

      parkHours = normalizeParkHours(park, scheduleData);
      const scheduleById = normalizeScheduleByEntity(park, scheduleData, parkHours);
      wikiItems = normalizeThemeParkItems(park, childrenData, liveData, scheduleById, parkHours);
      sourceParts.push("ThemeParks.wiki API/cache");
    } catch (error) {
      console.warn(error);
      sourceParts.push("ThemeParks.wiki unavailable");
    }

    const merged = mergeParkItems(wikiItems, queueItems);
    const withManualEvents = addManualEvents(park, merged);
    const withSingleRider = attachSingleRiderInfo(withManualEvents);

    return {
      park,
      source: sourceParts.join(" + "),
      parkHours,
      items: withSingleRider
    };
  }

  async function fetchJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.json();
  }

  async function fetchThemeParksJson(park, kind) {
    const cacheKey = `${park.id}.${kind}`;
    const url = `https://api.themeparks.wiki/v1/entity/${park.themeParksEntityId}/${kind}`;

    try {
      const data = await fetchJson(url);
      saveRuntimeCache(cacheKey, data);
      return data;
    } catch (networkError) {
      const staticData = await readStaticCache(cacheKey);
      if (staticData) return staticData;

      const runtimeData = readRuntimeCache(cacheKey);
      if (runtimeData) return runtimeData;

      throw networkError;
    }
  }

  async function readStaticCache(cacheKey) {
    try {
      const response = await fetch(`src/cache/themeparks/${cacheKey}.json`, { cache: "no-store" });
      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  }

  function saveRuntimeCache(cacheKey, data) {
    try {
      localStorage.setItem(`${CACHE_PREFIX}${cacheKey}`, JSON.stringify({ savedAt: new Date().toISOString(), data }));
    } catch (error) {
      console.warn("Unable to save runtime cache", error);
    }
  }

  function readRuntimeCache(cacheKey) {
    try {
      const cached = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${cacheKey}`) || "null");
      return cached?.data || null;
    } catch {
      return null;
    }
  }

  function normalizeQueueData(park, data) {
    const items = [];
    const lands = Array.isArray(data.lands) ? data.lands : [];
    const rootRides = Array.isArray(data.rides) ? data.rides : [];

    lands.forEach((land, landIndex) => {
      (land.rides || []).forEach((ride, rideIndex) => {
        items.push(queueRideToItem(park, ride, land.name, landIndex, rideIndex));
      });
    });

    rootRides.forEach((ride, rideIndex) => {
      items.push(queueRideToItem(park, ride, "Other", lands.length, rideIndex));
    });

    return items;
  }

  function queueRideToItem(park, ride, land, landIndex, rideIndex) {
    const meta = findAttractionMeta(ride.name) || estimateLocation(park, landIndex, rideIndex);
    return {
      id: `queue-${park.id}-${ride.id}`,
      externalId: ride.id,
      parkId: park.id,
      parkName: park.displayName,
      name: ride.name,
      category: "attraction",
      entityType: "ATTRACTION",
      land,
      status: ride.is_open ? "OPERATING" : "CLOSED",
      isOpen: Boolean(ride.is_open),
      waitTime: Number.isFinite(ride.wait_time) ? ride.wait_time : null,
      times: [],
      note: "",
      lat: meta.lat,
      lon: meta.lon,
      locationSource: findAttractionMeta(ride.name) ? "curated" : "estimated",
      source: "Queue Times API",
      isSingleRiderEntry: isSingleRiderName(ride.name)
    };
  }

  function normalizeThemeParkItems(park, childrenData, liveData, scheduleById, parkHours) {
    const children = Array.isArray(childrenData.children) ? childrenData.children : [];
    const liveList = Array.isArray(liveData.liveData) ? liveData.liveData : [];
    const liveById = new Map(liveList.map((item) => [item.id, item]));

    return children
      .map((child, index) => {
        const live = liveById.get(child.id) || {};
        const entityType = child.entityType || live.entityType || "";
        const category = getCategory(entityType);
        if (!category) return null;

        const merged = { ...child, ...live };
        const meta = locationFromEntity(merged) || findAttractionMeta(merged.name) || estimateLocation(park, index, 0);
        const liveTimes = category === "entertainment" ? extractShowtimes(park, merged, parkHours) : [];
        const scheduleTimes = category === "entertainment" ? scheduleById.get(child.id) || [] : [];
        const times = uniqueTimes(liveTimes.length ? liveTimes : scheduleTimes);

        return {
          id: child.id,
          externalId: child.id,
          parkId: park.id,
          parkName: park.displayName,
          name: merged.name,
          category,
          entityType,
          land: merged.land || merged.area || "Uncategorized",
          status: merged.status || "UNKNOWN",
          isOpen: isOpenStatus(merged.status),
          waitTime: extractWaitTime(merged),
          times,
          note: "",
          lat: meta.lat,
          lon: meta.lon,
          locationSource: locationFromEntity(merged) || findAttractionMeta(merged.name) ? "curated" : "estimated",
          source: "ThemeParks.wiki API/cache",
          isSingleRiderEntry: isSingleRiderName(merged.name)
        };
      })
      .filter(Boolean);
  }

  function normalizeScheduleByEntity(park, scheduleData, parkHours) {
    const entries = Array.isArray(scheduleData.schedule) ? scheduleData.schedule : [];
    const byId = new Map();

    entries.forEach((entry) => {
      const id = entry.id || entry.entityId;
      if (!id) return;
      const time = formatScheduleEntry(park, entry);
      if (!time || !isTimeInsideParkHours(time, parkHours)) return;
      const list = byId.get(id) || [];
      list.push(time);
      byId.set(id, uniqueTimes(list));
    });

    return byId;
  }

  function normalizeParkHours(park, scheduleData) {
    const entries = Array.isArray(scheduleData.schedule) ? scheduleData.schedule : [];
    const today = getParkDate(park);

    const hours = entries
      .filter((entry) => {
        const hasOpenClose = entry.openingTime || entry.closingTime;
        const id = entry.id || entry.entityId;
        const date = String(entry.date || entry.openingTime || "");
        return hasOpenClose && !id && (!date || getDateInZone(entry.openingTime || date, park.timezone) === today);
      })
      .map((entry) => formatScheduleEntry(park, entry))
      .filter(Boolean);

    return uniqueTimes(hours.length ? hours : park.fallbackHours || []);
  }

  function mergeParkItems(wikiItems, queueItems) {
    if (!wikiItems.length) return queueItems;

    const queueByName = new Map(queueItems.map((item) => [normalizeName(item.name), item]));

    const merged = wikiItems.map((wikiItem) => {
      const queueItem = queueByName.get(normalizeName(wikiItem.name));
      if (!queueItem) return wikiItem;
      return {
        ...wikiItem,
        land: wikiItem.land === "Uncategorized" ? queueItem.land : wikiItem.land,
        waitTime: queueItem.waitTime,
        isOpen: queueItem.isOpen,
        status: queueItem.status,
        source: `${wikiItem.source} + Queue Times API`
      };
    });

    const knownNames = new Set(merged.map((item) => normalizeName(item.name)));
    queueItems.forEach((queueItem) => {
      if (!knownNames.has(normalizeName(queueItem.name))) merged.push(queueItem);
    });

    return merged;
  }

  function addManualEvents(park, items) {
    const existingNames = new Set(items.map((item) => normalizeName(item.name)));
    const manualItems = MANUAL_EVENTS
      .filter((event) => event.park === park.id && !existingNames.has(normalizeName(event.name)))
      .map((event) => {
        const meta = findAttractionMeta(event.name) || estimateLocation(park, 0, 0);
        return {
          id: event.id,
          externalId: event.id,
          parkId: park.id,
          parkName: park.displayName,
          name: event.name,
          category: event.category,
          entityType: event.entityType,
          land: event.land,
          status: event.status,
          isOpen: true,
          waitTime: null,
          times: event.times,
          note: event.note,
          lat: meta.lat,
          lon: meta.lon,
          locationSource: "curated",
          source: "Manual fallback",
          isSingleRiderEntry: false
        };
      });

    return [...items, ...manualItems];
  }

  function attachSingleRiderInfo(items) {
    const singleRiderByBaseName = new Map();
    items.forEach((item) => {
      if (item.isSingleRiderEntry) {
        singleRiderByBaseName.set(normalizeName(removeSingleRiderSuffix(item.name)), item);
      }
    });

    return items
      .filter((item) => !item.isSingleRiderEntry)
      .map((item) => {
        const singleRider = singleRiderByBaseName.get(normalizeName(item.name));
        if (!singleRider) return item;
        return {
          ...item,
          hasSingleRider: true,
          singleRiderStatus: singleRider.status,
          singleRiderWaitTime: singleRider.waitTime
        };
      });
  }

  function getCategory(entityType) {
    if (ATTRACTION_TYPES.has(entityType)) return "attraction";
    if (ENTERTAINMENT_TYPES.has(entityType)) return "entertainment";
    return null;
  }

  function isOpenStatus(status) {
    return ["OPERATING", "OPEN", "SCHEDULED"].includes(String(status || "").toUpperCase());
  }

  function extractWaitTime(item) {
    const standby = item.queue?.STANDBY || item.queue?.standby;
    const waitTime = standby?.waitTime ?? item.waitTime ?? item.wait_time;
    return Number.isFinite(waitTime) ? waitTime : null;
  }

  function extractShowtimes(park, item, parkHours) {
    const showtimes = item.showtimes || item.showTimes || [];
    if (!Array.isArray(showtimes)) return [];

    return uniqueTimes(
      showtimes
        .map((showtime) => formatShowtime(park, showtime))
        .filter(Boolean)
        .filter((time) => isTimeInsideParkHours(time, parkHours))
    );
  }

  function formatShowtime(park, showtime) {
    const start = showtime.startTime || showtime.start || showtime.startDate;
    const end = showtime.endTime || showtime.end || showtime.endDate;
    if (!start || getDateInZone(start, park.timezone) !== getParkDate(park)) return "";

    const startClock = formatClock(start, park.timezone);
    const endClock = end && getDateInZone(end, park.timezone) === getParkDate(park) ? formatClock(end, park.timezone) : "";
    if (!endClock || endClock === startClock) return startClock;
    return `${startClock} - ${endClock}`;
  }

  function formatScheduleEntry(park, entry) {
    const start = entry.openingTime || entry.startTime || entry.start || entry.date;
    const end = entry.closingTime || entry.endTime || entry.end;
    if (!start && !end) return "";

    const startClock = start ? formatClock(start, park.timezone) : "";
    const endClock = end ? formatClock(end, park.timezone) : "";
    if (!endClock || endClock === startClock) return startClock;
    return `${startClock} - ${endClock}`;
  }

  function isTimeInsideParkHours(timeText, parkHours) {
    if (!parkHours?.length) return true;
    const startMinute = parseClockToMinute(timeText.split(" - ")[0]);
    if (startMinute === null) return true;

    return parkHours.some((range) => {
      const [openText, closeText] = range.split(" - ");
      const open = parseClockToMinute(openText);
      let close = parseClockToMinute(closeText);
      if (open === null || close === null) return true;
      if (close === 0 || close < open) close += 24 * 60;
      const candidate = startMinute < open ? startMinute + 24 * 60 : startMinute;
      return candidate >= open - 30 && candidate <= close + 45;
    });
  }

  function parseClockToMinute(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  }

  function getFilteredItems() {
    const search = state.search.trim().toLowerCase();
    return state.items
      .filter((item) => state.selectedPark === "all" || item.parkId === state.selectedPark)
      .filter((item) => state.selectedType === "all" || item.category === state.selectedType)
      .filter((item) => {
        if (state.selectedStatus === "open") return item.isOpen;
        if (state.selectedStatus === "closed") return !item.isOpen;
        return true;
      })
      .filter((item) => !search || item.name.toLowerCase().includes(search) || item.land.toLowerCase().includes(search))
      .sort(sortItems);
  }

  function sortItems(a, b) {
    if (a.parkId !== b.parkId) return a.parkId.localeCompare(b.parkId);
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if ((b.waitTime || 0) !== (a.waitTime || 0)) return (b.waitTime || 0) - (a.waitTime || 0);
    return a.name.localeCompare(b.name);
  }

  function render() {
    const filteredItems = getFilteredItems();
    renderSummary(filteredItems);
    if (page === "attractions") renderCatalog(filteredItems);
    if (page === "schedule") renderSchedule(filteredItems);
    if (page === "map") renderMap(filteredItems);
  }

  function renderSummary(items) {
    if (!elements.openCount) return;

    const attractionItems = items.filter((item) => item.category === "attraction");
    const openAttractions = attractionItems.filter((item) => item.isOpen);
    const waits = openAttractions.map((item) => item.waitTime).filter(Number.isFinite);
    const average = waits.length ? Math.round(waits.reduce((sum, wait) => sum + wait, 0) / waits.length) : 0;
    const maxWait = waits.length ? Math.max(...waits) : 0;

    elements.openCount.textContent = `${openAttractions.length}`;
    elements.averageWait.textContent = `${average} min`;
    elements.maxWait.textContent = maxWait ? `${maxWait} min` : "N/A";
    elements.dataSource.textContent = formatSourceSummary();
  }

  function renderCatalog(items) {
    if (!elements.catalogRoot) return;
    if (!items.length) {
      elements.catalogRoot.innerHTML = `<p class="empty-state">No matching items.</p>`;
      return;
    }

    elements.catalogRoot.innerHTML = getVisibleParks()
      .map((park) => {
        const parkItems = items.filter((item) => item.parkId === park.id);
        if (!parkItems.length) return "";
        return `
          <section class="park-section">
            <div class="park-section-header">
              <h2>${escapeHtml(park.displayName)}</h2>
              <p>${escapeHtml(state.sources[park.id] || "Loading")}</p>
            </div>
            <div class="category-columns">
              ${renderCategoryColumn("Attractions", parkItems.filter((item) => item.category === "attraction"))}
              ${renderCategoryColumn("Entertainment", parkItems.filter((item) => item.category === "entertainment"))}
            </div>
          </section>
        `;
      })
      .join("");
  }

  function renderCategoryColumn(title, items) {
    return `
      <article class="category-column">
        <div class="column-title">
          <h3>${title}</h3>
          <span>${items.length} items</span>
        </div>
        <div class="item-list">
          ${items.length ? items.map(renderItemCard).join("") : `<p class="muted">No data</p>`}
        </div>
      </article>
    `;
  }

  function renderItemCard(item) {
    const waitText = item.waitTime === null ? "No wait data" : `${item.waitTime} min`;
    const timeText = item.times.length ? item.times.join(" / ") : "No showtime";
    const singleRider = item.hasSingleRider
      ? `<span class="badge">Single Rider${Number.isFinite(item.singleRiderWaitTime) ? ` · ${item.singleRiderWaitTime} min` : ""}</span>`
      : "";

    return `
      <article class="item-card">
        <div>
          <h4>${escapeHtml(item.name)}</h4>
          <p>${escapeHtml(item.land)} · ${escapeHtml(item.entityType || item.category)}</p>
          <div class="badges">
            <span class="status ${item.isOpen ? "open" : "closed"}">${escapeHtml(item.status || "UNKNOWN")}</span>
            ${singleRider}
          </div>
        </div>
        <div class="item-side">
          <strong>${item.category === "attraction" ? waitText : "Show"}</strong>
          <span>${escapeHtml(timeText)}</span>
        </div>
      </article>
    `;
  }

  function renderSchedule(items) {
    if (!elements.scheduleRoot) return;
    renderParkHours();

    const scheduleItems = items.filter((item) => item.category === "entertainment" && item.times.length);

    elements.scheduleRoot.innerHTML =
      getVisibleParks()
        .map((park) => {
          const parkItems = scheduleItems.filter((item) => item.parkId === park.id);
          if (!parkItems.length) return "";
          return `
            <section class="park-section">
              <div class="park-section-header">
                <h2>${escapeHtml(park.displayName)} Entertainment</h2>
                <p>${escapeHtml(state.sources[park.id] || "Loading")}</p>
              </div>
              <div class="schedule-list">
                ${parkItems.map(renderScheduleRow).join("")}
              </div>
            </section>
          `;
        })
        .join("") || `<p class="empty-state">No entertainment showtimes for the selected park.</p>`;
  }

  function renderParkHours() {
    if (!elements.parkHoursRoot) return;
    elements.parkHoursRoot.innerHTML = `
      <section class="hours-grid">
        ${getVisibleParks()
          .map((park) => {
            const hours = state.parkHours[park.id] || park.fallbackHours || [];
            return `
              <article class="hours-card">
                <span>Park hours</span>
                <h2>${escapeHtml(park.displayName)}</h2>
                <p>${hours.length ? hours.map(escapeHtml).join(" / ") : "No official park hours data"}</p>
              </article>
            `;
          })
          .join("")}
      </section>
    `;
  }

  function renderScheduleRow(item) {
    return `
      <article class="schedule-row">
        <div>
          <h3>${escapeHtml(item.name)}</h3>
          <p>${escapeHtml(item.land)} · Entertainment · ${escapeHtml(item.source)}</p>
        </div>
        <div class="time-chips">
          ${item.times.map((time) => `<span>${escapeHtml(time)}</span>`).join("")}
        </div>
      </article>
    `;
  }

  function renderMap(items) {
    if (!elements.leafletMap || !elements.mapList) return;
    const mappableItems = items.filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon) && item.locationSource !== "estimated");
    const hiddenCount = items.length - mappableItems.length;

    renderLeafletMap(mappableItems);
    elements.mapList.innerHTML = `
      ${hiddenCount > 0 ? `<p class="muted">${hiddenCount} items do not have trusted coordinates yet, so they are not shown on the map.</p>` : ""}
      ${mappableItems.slice(0, 100).map(renderMapListItem).join("")}
    `;
  }

  function renderLeafletMap(items) {
    if (!state.leafletReady || !window.L) {
      if (elements.mapFallback) elements.mapFallback.hidden = false;
      return;
    }

    if (elements.mapFallback) elements.mapFallback.hidden = true;

    if (!leafletMap) {
      leafletMap = L.map(elements.leafletMap, {
        center: [33.809, -117.9197],
        zoom: 16,
        minZoom: 14,
        maxZoom: 19
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap contributors"
      }).addTo(leafletMap);

      markerLayer = L.layerGroup().addTo(leafletMap);
    }

    markerLayer.clearLayers();

    const bounds = [];
    items.forEach((item) => {
      const marker = L.marker([item.lat, item.lon], {
        icon: L.divIcon({
          className: `leaflet-wait-marker ${item.category === "entertainment" ? "show" : waitIntensity(item.waitTime)}`,
          html: "",
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        })
      });

      marker.bindPopup(`
        <strong>${escapeHtml(item.name)}</strong><br>
        ${escapeHtml(item.parkName)} · ${escapeHtml(item.land)}<br>
        ${item.category === "attraction" ? escapeHtml(item.waitTime === null ? "No wait data" : `${item.waitTime} min`) : "Entertainment"}
      `);
      marker.addTo(markerLayer);
      bounds.push([item.lat, item.lon]);
    });

    if (bounds.length) leafletMap.fitBounds(bounds, { padding: [28, 28], maxZoom: 17 });
  }

  function renderMapListItem(item) {
    const wait = item.waitTime === null ? "No wait data" : `${item.waitTime} min`;
    return `
      <article>
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.parkName)} · ${escapeHtml(item.land)} · ${item.category === "attraction" ? wait : "Show"}</span>
      </article>
    `;
  }

  async function loadLeafletAssets() {
    if (window.L) return true;
    await loadFirstAvailableStylesheet(LEAFLET_CSS_URLS);
    return loadFirstAvailableScript(LEAFLET_JS_URLS);
  }

  function loadFirstAvailableStylesheet(urls) {
    return new Promise((resolve) => {
      let index = 0;
      const tryNext = () => {
        if (index >= urls.length) return resolve(false);
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = urls[index++];
        link.onload = () => resolve(true);
        link.onerror = tryNext;
        document.head.appendChild(link);
      };
      tryNext();
    });
  }

  function loadFirstAvailableScript(urls) {
    return new Promise((resolve) => {
      let index = 0;
      const tryNext = () => {
        if (index >= urls.length) return resolve(false);
        const script = document.createElement("script");
        script.src = urls[index++];
        script.onload = () => resolve(Boolean(window.L));
        script.onerror = tryNext;
        document.head.appendChild(script);
      };
      tryNext();
    });
  }

  function getVisibleParks() {
    return state.selectedPark === "all" ? Object.values(PARKS) : [PARKS[state.selectedPark]];
  }

  function formatSourceSummary() {
    return getVisibleParks().map((park) => `${park.name}: ${state.sources[park.id] || "Loading"}`).join(" / ");
  }

  function updateRefreshStatus(message) {
    const refreshText = document.querySelector("#refreshText");
    if (!refreshText) return;
    const time = state.lastUpdated ? `Last update ${formatClock(state.lastUpdated.toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone)}` : "first update pending";
    refreshText.textContent = `${message} · ${time} · refreshes every 5 min`;
  }

  function createDataSignature(items) {
    if (!items.length) return "";
    return JSON.stringify(
      items
        .map((item) => [item.id, item.status, item.waitTime, item.times.join("|")])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
  }

  function findAttractionMeta(name) {
    const normalizedName = normalizeName(name);
    return Object.entries(ATTRACTION_META).find(([metaName]) => normalizeName(metaName) === normalizedName)?.[1];
  }

  function locationFromEntity(entity) {
    const location = entity.location || entity.coordinates;
    if (!location) return null;
    const lat = Number(location.latitude ?? location.lat);
    const lon = Number(location.longitude ?? location.lng ?? location.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }

  function estimateLocation(park, landIndex, rideIndex) {
    const bounds = park.bounds;
    const columns = 5;
    const rows = 5;
    const col = (landIndex + rideIndex) % columns;
    const row = (landIndex * 2 + rideIndex) % rows;
    return {
      lat: bounds.north - (bounds.north - bounds.south) * ((row + 0.5) / rows),
      lon: bounds.west + (bounds.east - bounds.west) * ((col + 0.5) / columns)
    };
  }

  function waitIntensity(waitTime) {
    if (!Number.isFinite(waitTime)) return "unknown";
    if (waitTime >= 60) return "high";
    if (waitTime >= 30) return "medium";
    return "low";
  }

  function uniqueTimes(times) {
    return Array.from(new Set(times)).sort((a, b) => (parseClockToMinute(a) || 0) - (parseClockToMinute(b) || 0));
  }

  function getParkDate(park) {
    return getDateInZone(new Date().toISOString(), park.timezone);
  }

  function getDateInZone(value, timezone) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  }

  function normalizeName(name) {
    return String(name)
      .toLowerCase()
      .replace(/[™®]/g, "")
      .replace(/[“”"]/g, "")
      .replace(/[’']/g, "")
      .replace(/[–—]/g, "-")
      .replace(/\bsingle rider\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isSingleRiderName(name) {
    return /\bsingle rider\b/i.test(String(name));
  }

  function removeSingleRiderSuffix(name) {
    return String(name).replace(/\s*single rider\s*/i, "").trim();
  }

  function formatClock(value, timezone) {
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(date).replace("24:", "00:");
    }
    return String(value).slice(0, 5);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
