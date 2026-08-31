(function () {
  "use strict";

  const lakes = window.LAKE_DATA;
  const lakeKeys = Object.keys(lakes);
  const fishGuide = window.FISH_GUIDE || {};
  const STORAGE_KEY = "klev-ryadom-journal-v1";
  const SETTINGS_KEY = "klev-ryadom-settings-v1";
  const WEATHER_CACHE_KEY = "klev-ryadom-weather-v1";
  const $ = (id) => document.getElementById(id);
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const fmt = (n, digits = 0) => Number.isFinite(n) ? n.toLocaleString("ru-RU", { maximumFractionDigits: digits }) : "—";
  const now = new Date();
  let selectedLake = "krivoe";
  let viewMode = "2d";
  let leafletMap = null;
  let leafletLayers = [];
  let leafletBaseLayer = null;
  let leafletLibraryPromise = null;
  let depthVisible = true;
  let zonesVisible = true;
  let mapState = { scale: 1, panX: 0, panY: 0, user: null };
  const activePointers = new Map();
  let mapGesture = null;
  let weather = null;
  let weatherError = false;
  let journal = readJson(STORAGE_KEY, []);
  let settings = Object.assign({ fish: "universal" }, readJson(SETTINGS_KEY, {}));
  let weatherCache = readJson(WEATHER_CACHE_KEY, {});
  let deferredInstallPrompt = null;
  let toastTimer = null;
  let weatherRequestId = 0;

  function readJson(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { showToast("Не удалось сохранить на устройстве"); }
  }
  function showToast(message, ms = 3000) {
    const el = $("toast"); if (!el) return;
    el.textContent = message; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[c]));
  }
  function setConnection(state, label) {
    const badge = $("connectionBadge"); if (!badge) return;
    badge.className = "connection-badge " + (state === "online" ? "is-online" : state === "syncing" ? "is-syncing" : "is-offline");
    qs("span", badge).textContent = label || (state === "online" ? "онлайн" : "локально");
  }
  function isOnline() { return navigator.onLine !== false; }
  function lake() { return lakes[selectedLake]; }
  function restoreWeatherCache(key = selectedLake) {
    const cached = weatherCache[key];
    if (!cached || !cached.data) return false;
    weather = cached.data;
    const age = Date.now() - Number(cached.at || 0);
    $("updatedLabel").textContent = age < 3600000 ? "из кэша · недавно" : "из кэша · " + new Date(cached.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    return true;
  }

  function setupNavigation() {
    qsa("[data-screen-target]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.screenTarget)));
    qsa(".lake-tab").forEach((button) => button.addEventListener("click", () => selectLake(button.dataset.lake)));
    $("mode2d").addEventListener("click", () => setMode("2d"));
    $("modeHybrid").addEventListener("click", () => setMode("hybrid"));
    $("mode3d").addEventListener("click", () => setMode("3d"));
    $("mapFishSelect").addEventListener("change", (event) => { settings.fish = event.target.value; writeJson(SETTINGS_KEY, settings); renderAll(); showToast("На карте: " + fishLabel(settings.fish), 1600); });
    $("depthToggle").addEventListener("click", () => { depthVisible = !depthVisible; updateToggle($("depthToggle"), depthVisible); viewMode === "hybrid" ? renderLeafletOverlays() : drawMap(); });
    $("zonesToggle").addEventListener("click", () => { zonesVisible = !zonesVisible; updateToggle($("zonesToggle"), zonesVisible); viewMode === "hybrid" ? renderLeafletOverlays() : drawMap(); });
    $("locateButton").addEventListener("click", locateUser);
    $("addPointButton").addEventListener("click", () => openPointModal());
    $("copyCoordinates").addEventListener("click", copyCoordinates);
    $("satelliteButton").addEventListener("click", openSatellite);
    $("refreshButton").addEventListener("click", () => fetchWeather(true));
    $("forecastRefresh").addEventListener("click", () => fetchWeather(true));
    $("fishSelect").addEventListener("change", (event) => { settings.fish = event.target.value; writeJson(SETTINGS_KEY, settings); renderAll(); });
    $("journalAddButton").addEventListener("click", () => openPointModal());
    $("journalEmptyButton").addEventListener("click", () => openPointModal());
    $("exportJsonButton").addEventListener("click", exportJson);
    $("exportCsvButton").addEventListener("click", exportCsv);
    $("clearJournalButton").addEventListener("click", clearJournal);
    $("modalClose").addEventListener("click", closePointModal);
    $("modalCancel").addEventListener("click", closePointModal);
    $("pointForm").addEventListener("submit", savePoint);
    $("pointModal").addEventListener("click", (event) => { if (event.target === $("pointModal")) closePointModal(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closePointModal(); });
    $("pointType").addEventListener("change", updatePointEstimate);
    $("pointDepth").addEventListener("input", updatePointEstimate);
    $("zoomOut").addEventListener("click", () => zoomMap(.78));
    $("zoomReset").addEventListener("click", () => resetMapView());
    $("zoomIn").addEventListener("click", () => zoomMap(1.28));
    window.addEventListener("popstate", () => navigate(location.hash.slice(1) || "map", false));
    window.addEventListener("online", () => { setConnection("online", "онлайн"); fetchWeather(false); });
    window.addEventListener("offline", () => { setConnection("offline", "локально"); showToast("Нет сети — работаю по последнему прогнозу"); });
    window.addEventListener("resize", resizeCanvas);
    window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstallPrompt = event; $("installButton").hidden = false; });
    $("installButton").addEventListener("click", async () => {
      if (!deferredInstallPrompt) { showToast("В Safari: «Поделиться» → «На экран Домой»"); return; }
      deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; $("installButton").hidden = true;
    });
    const canvas = $("lakeCanvas");
    canvas.addEventListener("pointerdown", mapPointerDown);
    canvas.addEventListener("pointermove", mapPointerMove);
    canvas.addEventListener("pointerup", mapPointerUp);
    canvas.addEventListener("pointercancel", mapPointerUp);
    canvas.addEventListener("wheel", (event) => { event.preventDefault(); const rect = canvas.getBoundingClientRect(); zoomMap(event.deltaY > 0 ? .92 : 1.08, { x: event.clientX - rect.left, y: event.clientY - rect.top }); }, { passive: false });
    const hybridSurface = $("leafletMap");
    hybridSurface?.addEventListener("click", (event) => { if (event.target.closest?.(".leaflet-marker-icon, .leaflet-interactive, .leaflet-control")) return; });
  }

  function navigate(target, push = true) {
    if (!/[a-z]+/.test(target) || !["map", "forecast", "journal", "about"].includes(target)) target = "map";
    if (target !== "map" && $("pointModal")) closePointModal();
    qsa(".screen").forEach((screen) => { const active = screen.dataset.screen === target; screen.hidden = !active; screen.classList.toggle("is-active", active); });
    qsa(".nav-item").forEach((button) => { const active = button.dataset.screenTarget === target; button.classList.toggle("is-active", active); if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
    if (push && location.hash !== "#" + target) history.pushState({}, "", "#" + target);
    if (target === "map") requestAnimationFrame(() => { resizeCanvas(); syncMapSurface(); });
    if (target === "journal") renderJournal();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function selectLake(key) {
    if (!lakes[key]) return;
    selectedLake = key; mapState.scale = 1; mapState.panX = 0; mapState.panY = 0; mapState.user = null; weather = null; weatherError = false; restoreWeatherCache(key);
    qsa(".lake-tab").forEach((button) => { const active = button.dataset.lake === key; button.classList.toggle("is-selected", active); button.setAttribute("aria-selected", String(active)); });
    renderAll();
    if (viewMode === "hybrid") syncMapSurface();
    showToast(lakes[key].name + " · карта обновлена", 1800); fetchWeather(false);
  }

  function setMode(mode) {
    viewMode = mode;
    $("mode2d").classList.toggle("is-active", mode === "2d"); $("mode2d").setAttribute("aria-pressed", String(mode === "2d"));
    $("modeHybrid").classList.toggle("is-active", mode === "hybrid"); $("modeHybrid").setAttribute("aria-pressed", String(mode === "hybrid"));
    $("mode3d").classList.toggle("is-active", mode === "3d"); $("mode3d").setAttribute("aria-pressed", String(mode === "3d"));
    $("mapModeLabel").textContent = mode === "3d" ? "3D · наклонный рельеф" : mode === "hybrid" ? "Гибрид · спутник + рельеф" : "2D · модельная батиметрия";
    $("lakeCanvas").dataset.mode = mode;
    renderMapMeta();
    syncMapSurface();
  }
  function updateToggle(button, active) { button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); }

  function weatherUrl() {
    const c = lake().center;
    const params = new URLSearchParams({ latitude: c[0], longitude: c[1], timezone: "Europe/Moscow", forecast_days: "2", current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m", hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m", daily: "sunrise,sunset" });
    return "https://api.open-meteo.com/v1/forecast?" + params;
  }
  async function fetchWeather(force) {
    if (!isOnline()) { weatherError = true; restoreWeatherCache(); setConnection("offline", "локально"); renderAll(); return; }
    const requestId = ++weatherRequestId; setConnection("syncing", "обновляю");
    try {
      const response = await fetch(weatherUrl(), { cache: force ? "no-store" : "default" });
      if (!response.ok) throw new Error("weather " + response.status);
      if (requestId !== weatherRequestId) return;
      weather = await response.json(); weatherError = false; weatherCache[selectedLake] = { at: Date.now(), data: weather }; writeJson(WEATHER_CACHE_KEY, weatherCache); setConnection("online", "онлайн");
      const stamp = new Date(); $("updatedLabel").textContent = "обновлено " + stamp.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      weatherError = true; if (!weather) restoreWeatherCache(); setConnection("offline", "локально");
      showToast("Погода недоступна — показываю локальную оценку", 3200);
    }
    renderAll();
  }

  function weatherCodeText(code) {
    const map = { 0: "ясно", 1: "малооблачно", 2: "переменная облачность", 3: "пасмурно", 45: "туман", 48: "туман", 51: "морось", 53: "морось", 55: "морось", 61: "дождь", 63: "дождь", 65: "сильный дождь", 71: "снег", 73: "снег", 75: "сильный снег", 80: "ливни", 81: "ливни", 82: "сильные ливни", 95: "гроза", 96: "гроза", 99: "гроза" };
    return map[code] || "условия меняются";
  }
  function weatherIcon(code, isDay = 1) {
    if ([61,63,65,80,81,82].includes(code)) return "☂";
    if ([71,73,75].includes(code)) return "❄";
    if ([95,96,99].includes(code)) return "ϟ";
    if ([45,48].includes(code)) return "≋";
    return isDay ? "☼" : "☾";
  }
  function localConditions(hour = new Date().getHours()) {
    const seasonal = Math.cos((hour - 13) / 24 * Math.PI * 2);
    return { temperature: 15 + seasonal * 4, apparent: 15 + seasonal * 4, humidity: 72, precipitation: 0, wind: 3.5, direction: 220, pressure: 1014, cloud: 45, rainProb: 12, code: 2, isDay: hour >= 5 && hour < 22 };
  }
  function currentConditions() {
    if (weather && weather.current) {
      const c = weather.current;
      const pNow = Number(c.pressure_msl ?? 1014); const pBefore = weather?.hourly?.pressure_msl ? Number(weather.hourly.pressure_msl[Math.max(0, nearestHourIndex(weather.hourly.time) - 3)] ?? pNow) : pNow;
      return { temperature: c.temperature_2m, apparent: c.apparent_temperature, humidity: c.relative_humidity_2m, precipitation: c.precipitation, wind: c.wind_speed_10m, direction: c.wind_direction_10m, pressure: pNow, pressureTrend: pNow - pBefore, cloud: c.cloud_cover, rainProb: currentHourly("precipitation_probability"), code: c.weather_code, isDay: c.is_day };
    }
    return localConditions();
  }
  function currentHourly(field) {
    if (!weather?.hourly?.time) return 12;
    const idx = nearestHourIndex(weather.hourly.time); return Number(weather.hourly[field]?.[idx] ?? 12);
  }
  function nearestHourIndex(times, target = Date.now()) {
    let best = 0, delta = Infinity;
    times.forEach((time, i) => { const d = Math.abs(new Date(time).getTime() - target); if (d < delta) { delta = d; best = i; } }); return best;
  }
  function solarHours(date = new Date()) {
    let sunrise = 6, sunset = 20;
    if (weather?.daily?.time && weather.daily.sunrise && weather.daily.sunset) {
      const day = date.toISOString().slice(0, 10); let idx = weather.daily.time.indexOf(day);
      if (idx < 0) idx = nearestHourIndex(weather.daily.time.map((x) => x + "T12:00"), date.getTime());
      const rise = new Date(weather.daily.sunrise[idx]); const set = new Date(weather.daily.sunset[idx]);
      if (Number.isFinite(rise.getTime())) sunrise = rise.getHours() + rise.getMinutes() / 60;
      if (Number.isFinite(set.getTime())) sunset = set.getHours() + set.getMinutes() / 60;
    }
    return { sunrise, sunset };
  }
  function dayPhaseScore(date = new Date()) {
    const h = date.getHours() + date.getMinutes() / 60; const solar = solarHours(date);
    const morning = Math.exp(-Math.pow((h - (solar.sunrise + 1)) / 2.2, 2));
    const evening = Math.exp(-Math.pow((h - (solar.sunset - 1)) / 2.4, 2));
    const midday = Math.exp(-Math.pow((h - ((solar.sunrise + solar.sunset) / 2)) / 4.5, 2));
    return clamp(0.46 + 0.33 * Math.max(morning, evening) + 0.08 * midday, 0, 1);
  }
  function moonScore(date = new Date()) {
    const synodic = 29.530588853; const known = Date.UTC(2000, 0, 6, 18, 14); const phase = ((date.getTime() - known) / 86400000 / synodic) % 1; const p = phase < 0 ? phase + 1 : phase;
    return .5 + .5 * Math.cos((p - .5) * Math.PI * 2);
  }
  function speciesFactor(kind, conditions, hour) {
    const temp = conditions.temperature;
    if (kind === "pike") return clamp(.68 + (conditions.cloud > 45 ? .13 : 0) + (conditions.wind >= 2 && conditions.wind <= 7 ? .13 : 0) + (hour <= 9 || hour >= 18 ? .08 : 0), .3, 1);
    if (kind === "perch") return clamp(.63 + (hour >= 6 && hour <= 10 ? .18 : 0) + (temp > 8 && temp < 24 ? .1 : 0), .3, 1);
    if (kind === "roach") return clamp(.6 + (temp > 7 && temp < 20 ? .16 : 0) + (conditions.wind < 6 ? .08 : 0), .3, 1);
    if (kind === "bream") return clamp(.58 + (temp > 8 && temp < 22 ? .14 : 0) + (hour <= 8 || hour >= 18 ? .14 : 0) + (conditions.wind < 7 ? .06 : 0), .3, 1);
    if (kind === "burbot") return clamp(.64 + (temp < 12 ? .2 : 0) + (hour >= 19 || hour <= 5 ? .12 : 0), .3, 1);
    if (kind === "zander") return clamp(.59 + (hour >= 19 || hour <= 6 ? .19 : 0) + (conditions.cloud > 45 ? .09 : 0) + (conditions.wind <= 8 ? .06 : 0), .3, 1);
    if (kind === "ruff") return clamp(.57 + (temp < 15 ? .18 : 0) + (hour >= 18 || hour <= 6 ? .1 : 0), .3, 1);
    return clamp(.65 + (conditions.wind >= 2 && conditions.wind <= 7 ? .12 : 0) + (conditions.cloud > 35 ? .06 : 0), .3, 1);
  }
  function scoreAt(date, kind = settings.fish, hotspot = null) {
    const c = conditionsAt(date);
    const hour = date.getHours();
    let score = 35;
    score += 19 * dayPhaseScore(date);
    score += 9 * moonScore(date);
    score += c.wind >= 1.5 && c.wind <= 7 ? 10 : c.wind < 1 ? -4 : c.wind <= 11 ? 2 : -9;
    score += c.pressure >= 1005 && c.pressure <= 1025 ? 8 : c.pressure > 1030 ? -3 : -1;
    score += c.pressureTrend > 1 ? 4 : c.pressureTrend < -3 ? -4 : 0;
    score += c.rainProb <= 35 ? 5 : c.rainProb <= 65 ? 0 : -8;
    score += c.cloud >= 25 && c.cloud <= 80 ? 4 : c.cloud < 10 ? -2 : 0;
    score += (speciesFactor(kind, c, hour) - .6) * 23;
    if (hotspot) {
      const typeBonus = kind === "pike" && hotspot.kind === "shallow" ? 8 : kind === "perch" && (hotspot.kind === "drop" || hotspot.kind === "deep") ? 8 : kind === "roach" && hotspot.kind === "stream" ? 7 : kind === "burbot" && hotspot.kind === "deep" ? 8 : hotspot.kind === "drop" ? 3 : 0;
      score += typeBonus + (hotspot.score - 74) * .12;
    }
    const lakeBias = {
      universal: { krivoe: 1, ulovnoe: -3, sukhodol: 4 },
      pike: { krivoe: 7, ulovnoe: 0, sukhodol: 4 },
      perch: { krivoe: 5, ulovnoe: 4, sukhodol: 1 },
      roach: { krivoe: -2, ulovnoe: 6, sukhodol: 5 },
      bream: { krivoe: -3, ulovnoe: 5, sukhodol: 7 },
      burbot: { krivoe: -1, ulovnoe: 7, sukhodol: 2 },
      zander: { krivoe: -4, ulovnoe: 1, sukhodol: 5 },
      ruff: { krivoe: 0, ulovnoe: 3, sukhodol: 1 }
    };
    score += (lakeBias[kind] || lakeBias.universal)[selectedLake] || 0;
    const localBoost = journal.filter((entry) => entry.lake === selectedLake && entry.type === "catch").length;
    score += clamp(localBoost * 1.5, 0, 8);
    return Math.round(clamp(score, 8, 94));
  }
  function conditionsAt(date) {
    if (!weather?.hourly?.time) return localConditions(date.getHours());
    const idx = nearestHourIndex(weather.hourly.time, date.getTime()); const h = weather.hourly;
    const previous = Math.max(0, idx - 3);
    return { temperature: Number(h.temperature_2m?.[idx] ?? 15), wind: Number(h.wind_speed_10m?.[idx] ?? 3.5), direction: Number(h.wind_direction_10m?.[idx] ?? 220), pressure: Number(h.pressure_msl?.[idx] ?? 1014), pressureTrend: Number(h.pressure_msl?.[idx] ?? 1014) - Number(h.pressure_msl?.[previous] ?? h.pressure_msl?.[idx] ?? 1014), cloud: Number(h.cloud_cover?.[idx] ?? 45), rainProb: Number(h.precipitation_probability?.[idx] ?? 12), code: Number(h.weather_code?.[idx] ?? 2), isDay: date.getHours() >= 5 && date.getHours() < 22 };
  }
  function confidence() {
    let n = weather ? 62 : 32;
    const depthQuality = String(lake().depthConfidence || "").toLowerCase();
    n += depthQuality.includes("низкая / средняя") ? 4 : depthQuality.includes("средняя") ? 8 : 0;
    n += Math.min(20, journal.filter((e) => e.lake === selectedLake && (e.type === "measure" || e.type === "catch")).length * 4);
    return clamp(n, 20, 92);
  }
  function scoreLabel(score) { return score >= 75 ? "хороший шанс" : score >= 55 ? "нормальный шанс" : "осторожный прогноз"; }
  function scoreReason(score, c) {
    if (c.wind > 10) return "ветер снижает комфорт";
    if (c.rainProb > 65) return "осадки могут сбить активность";
    if (score >= 75) return "время и условия складываются";
    return "проверьте кромку и смену глубины";
  }

  function renderAll() {
    const l = lake(); const c = currentConditions(); const score = scoreAt(new Date());
    $("lakeTitle").textContent = l.name; $("lakeAliases").textContent = l.aliases; $("lakeDescription").textContent = l.waterNote;
    $("scoreValue").textContent = score; $("scoreRing").style.setProperty("--score", score); $("scoreRing").setAttribute("aria-label", "Шанс клёва " + score + " из 100"); $("scoreLabel").textContent = scoreLabel(score); $("scoreReason").textContent = scoreReason(score, c);
    $("currentWeather").textContent = fmt(c.temperature, 0) + "° · " + weatherIcon(c.code, c.isDay);
    $("currentWeatherMeta").textContent = fmt(c.wind, 0) + " м/с · " + fmt(c.pressure, 0) + " гПа · " + weatherCodeText(c.code);
    $("depthSummary").textContent = l.depthLabel; $("depthMeta").textContent = l.depthSource + " · " + l.depthConfidence.toLowerCase();
    renderMapMeta(); renderDepthScale(); renderDepthAudit(); renderFishMapGuide(); renderBestWindow(); renderBestZone(); renderCompare(); renderConditions(); renderFishGuide(); renderForecast(); renderJournal(); renderSources(); resizeCanvas(); if (viewMode === "hybrid") syncMapSurface();
    $("fishSelect").value = settings.fish;
    const mapFishSelect = $("mapFishSelect"); if (mapFishSelect) { mapFishSelect.value = settings.fish; }
  }

  function depthText(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " м" : "—";
  }
  function renderMapMeta() {
    const l = lake(); const center = l.center; const target = fishLabel(settings.fish);
    const hint = viewMode === "hybrid" ? "Масштабируйте двумя пальцами · реальные тайлы требуют сети" : viewMode === "3d" ? "Перетащите · двумя пальцами — наклон и масштаб" : "Перетащите карту · двумя пальцами — масштаб";
    $("mapHint").textContent = hint + " · точки: " + target; $("mapFishLabel").textContent = "рыба: " + target; $("mapScale").textContent = l.area + " · " + l.depthLabel; $("copyCoordinates").textContent = "коорд.: " + Number(center[0]).toFixed(6) + ", " + Number(center[1]).toFixed(6); updateZoomUi();
  }
  function renderDepthScale() {
    const l = lake(); const levels = Array.isArray(l.contourLevels) ? l.contourLevels : [];
    const chips = $("depthScaleChips"); const note = $("depthScaleNote"); const confidence = $("depthConfidenceChip");
    if (!chips || !note || !confidence) return;
    chips.innerHTML = levels.map((level, index) => `<span class="depth-scale-chip ${index === levels.length - 1 ? "is-deep" : ""}">${escapeHtml(depthText(level))}</span>`).join("");
    confidence.textContent = "уверенность: " + String(l.depthConfidence || "неизвестна").toLowerCase();
    note.textContent = (l.depthNote || "Глубины — ориентир, проверьте эхолотом.") + " Контуры — визуальная интерполяция.";
  }
  function renderDepthAudit() {
    const target = $("depthAuditList"); if (!target) return;
    target.innerHTML = lakeKeys.map((key) => {
      const l = lakes[key]; const evidence = Array.isArray(l.depthEvidence) ? l.depthEvidence : [];
      const statusClass = String(l.depthConfidence || "").toLowerCase().includes("средняя") ? "is-medium" : "";
      const rows = evidence.map((item) => `<div class="depth-evidence-row ${item.excluded ? "is-excluded" : ""}"><strong>${escapeHtml(item.source || "Источник")}</strong><span class="depth-evidence-value">${escapeHtml(item.value || "—")}</span><small>${escapeHtml(item.type || "")} · ${escapeHtml(item.note || "")}</small><a href="${escapeHtml(item.href || "#")}" target="_blank" rel="noreferrer" aria-label="Открыть источник: ${escapeHtml(item.source || "")}">↗</a></div>`).join("");
      return `<article class="depth-audit-card"><div class="depth-audit-card-head"><div><strong>${escapeHtml(l.name)}</strong><div class="depth-audit-claim">${escapeHtml(l.depthLabel)}</div></div><span class="depth-audit-status ${statusClass}">${escapeHtml(l.depthConfidence || "нет оценки")}</span></div><div class="depth-audit-evidence">${rows || "<small>Нет опубликованного числового подтверждения.</small>"}</div><p class="depth-audit-note">${escapeHtml(l.depthNote || "Глубина ориентировочная; проверьте промером.")}</p></article>`;
    }).join("");
  }
  function rankedHotspots(kind = settings.fish) {
    const target = kind || "universal";
    return (lake().hotspots || []).map((spot) => ({ spot, score: scoreAt(new Date(), target, spot) })).sort((a, b) => b.score - a.score);
  }
  function renderFishMapGuide() {
    const target = settings.fish || "universal"; const label = fishLabel(target); const ranked = rankedHotspots(target); const points = $("fishMapPoints"); const title = $("fishMapTitle"); const targetEl = $("fishMapTarget"); const note = $("fishMapNote"); const mapSelect = $("mapFishSelect");
    if (!points || !title || !targetEl || !note) return;
    if (mapSelect) {
      const available = new Set(["universal", ...(lake().fishKinds || [])]);
      mapSelect.innerHTML = ["universal", ...(lake().fishKinds || [])].filter((kind, index, arr) => available.has(kind) && arr.indexOf(kind) === index).map((kind) => `<option value="${escapeHtml(kind)}">${escapeHtml(fishLabel(kind))}</option>`).join("");
      mapSelect.value = available.has(target) ? target : "universal";
    }
    title.textContent = target === "universal" ? "Перспективные точки" : "Лучшие точки на карте";
    targetEl.textContent = label;
    points.innerHTML = ranked.slice(0, 3).map((item, index) => `<button type="button" class="fish-map-point ${index === 0 ? "is-best" : ""}" data-hotspot-id="${escapeHtml(item.spot.id)}"><span class="fish-map-rank">${index + 1}</span><span class="fish-map-point-main"><strong>${escapeHtml(item.spot.name)}</strong><small>${escapeHtml(item.spot.depth)} · ${escapeHtml(item.spot.species)}</small></span><b>${item.score}</b></button>`).join("");
    note.textContent = target === "universal" ? "Показаны три стартовые зоны; выберите вид рыбы, чтобы пересчитать рейтинг." : "Золотые маркеры на карте — три лучшие зоны для выбранной рыбы. Рейтинг ориентировочный.";
    qsa("[data-hotspot-id]").forEach((button) => button.addEventListener("click", () => focusHotspot(button.dataset.hotspotId)));
  }
  function focusHotspot(id) {
    const spot = (lake().hotspots || []).find((item) => item.id === id); if (!spot) return;
    if (viewMode === "hybrid" && leafletMap) { leafletMap.setView([spot.lat, spot.lon], Math.max(leafletMap.getZoom(), 15), { animate: true }); showMapToast(spot.name + " · " + spot.depth + " · " + fishLabel(settings.fish), 2600); return; }
    const canvas = $("lakeCanvas"); if (!canvas || !canvas.clientWidth) return;
    const bounds = mapBounds(); const p = projectPoint(spot.lat, spot.lon, canvas.clientWidth, canvas.clientHeight, bounds, 34); const cx = canvas.clientWidth / 2; const cy = canvas.clientHeight / 2;
    mapState.scale = Math.max(mapState.scale, 1.65); mapState.panX = cx - (cx + (p.x - cx) * mapState.scale); mapState.panY = cy - (cy + (p.y - cy) * mapState.scale); constrainMapPan(canvas.clientWidth, canvas.clientHeight); drawMap(); showMapToast(spot.name + " · " + spot.depth + " · " + fishLabel(settings.fish), 2600);
  }
  function renderBestWindow() {
    const windows = bestWindows(3); const first = windows[0];
    $("bestWindow").textContent = first ? first.label : "проверьте рассвет"; $("bestWindowReason").textContent = first ? first.reason : "Сеть недоступна — используйте локальный ориентир"; $("bestWindowScore").textContent = first ? first.score + "/100" : "—";
  }
  function renderBestZone() {
    const l = lake(); const best = l.hotspots.map((spot) => ({ spot, score: scoreAt(new Date(), settings.fish, spot) })).sort((a, b) => b.score - a.score)[0];
    $("bestZone").textContent = best ? best.spot.name : "первый свал"; $("bestZoneMeta").textContent = best ? best.spot.depth + " · " + best.spot.species : "модельная перспективная зона"; $("bestZoneScore").textContent = best ? best.score + "/100" : "—";
  }

  function fishLabel(kind) {
    if (kind === "universal") return "универсальная рыбалка";
    return fishGuide[kind]?.label || kind;
  }
  function moonPhaseName(date = new Date()) {
    const synodic = 29.530588853; const known = Date.UTC(2000, 0, 6, 18, 14); const phase = ((date.getTime() - known) / 86400000 / synodic) % 1; const p = phase < 0 ? phase + 1 : phase;
    if (p < .03 || p >= .97) return "новолуние";
    if (p < .22) return "растущий серп";
    if (p < .28) return "первая четверть";
    if (p < .47) return "растущая луна";
    if (p < .53) return "полнолуние";
    if (p < .72) return "убывающая луна";
    if (p < .78) return "последняя четверть";
    return "убывающий серп";
  }
  function lightPhase(date = new Date()) {
    const solar = solarHours(date); const h = date.getHours() + date.getMinutes() / 60;
    if (h < solar.sunrise - .7) return "предрассвет";
    if (h < solar.sunrise + 1.8) return "утренний выход";
    if (h > solar.sunset + .5) return "сумерки";
    if (h > solar.sunset - 2.2) return "вечерняя кромка";
    return "дневное окно";
  }
  function clockLabel(decimal) { const minutes = Math.round(Number(decimal || 0) * 60); const hours = Math.floor(minutes / 60) % 24; return String(hours).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0"); }
  function windDetail(c) {
    if (c.wind < 1.5) return "штиль: рябь слабая, ищите активность на мелководье";
    if (c.wind <= 7) return "умеренная рябь: корм сносит к наветренной кромке";
    if (c.wind <= 11) return "ветрено: кромка перспективна, но выходите осторожно";
    return "сильный ветер: комфорт и безопасность важнее дальнего заброса";
  }
  function pressureDetail(c) {
    if (c.pressureTrend > 1) return "растёт · часто короткое активное окно";
    if (c.pressureTrend < -3) return "заметно падает · клёв может быть рваным";
    if (c.pressure >= 1005 && c.pressure <= 1025) return "в рабочем диапазоне · без резкого скачка";
    return "вне привычного диапазона · проверяйте несколько горизонтов";
  }
  function renderConditions() {
    const l = lake(); const c = currentConditions(); const date = new Date(); const score = scoreAt(date); const solar = solarHours(date);
    const cards = [
      { icon: "≋", label: "Ветер", value: fmt(c.wind, 0) + " м/с · " + directionName(c.direction), detail: windDetail(c), tone: c.wind >= 1.5 && c.wind <= 7 ? "good" : c.wind > 10 ? "warn" : "neutral" },
      { icon: "↕", label: "Давление", value: fmt(c.pressure, 0) + " гПа", detail: pressureDetail(c), tone: c.pressureTrend > 1 || (c.pressure >= 1005 && c.pressure <= 1025) ? "good" : c.pressureTrend < -3 ? "warn" : "neutral" },
      { icon: weatherIcon(c.code, c.isDay), label: "Небо и дождь", value: fmt(c.cloud, 0) + "% облаков", detail: c.rainProb > 50 ? "осадки вероятны · нужен запасной план" : weatherCodeText(c.code) + " · осадки " + fmt(c.rainProb, 0) + "%", tone: c.rainProb > 65 ? "warn" : c.cloud >= 25 && c.cloud <= 80 ? "good" : "neutral" },
      { icon: "☼", label: "Световой ритм", value: lightPhase(date), detail: "рассвет " + clockLabel(solar.sunrise) + " · закат " + clockLabel(solar.sunset), tone: dayPhaseScore(date) > .7 ? "good" : "neutral" },
      { icon: "☾", label: "Лунный фон", value: moonPhaseName(date), detail: "ритмический бонус модели " + Math.round(moonScore(date) * 100) + "/100", tone: moonScore(date) > .65 ? "good" : "neutral" },
      { icon: "°", label: "Ощущается", value: fmt(c.apparent, 0) + "° · " + fmt(c.humidity, 0) + "%", detail: "влажность · осадков сейчас " + fmt(c.precipitation, 1) + " мм", tone: c.humidity >= 45 && c.humidity <= 90 ? "neutral" : "warn" },
      { icon: "⌁", label: "Рельеф и корм", value: l.depthLabel, detail: l.hotspots.length + " сценария для старта · " + l.depthConfidence.toLowerCase() + " уверенность", tone: l.depthConfidence.toLowerCase().includes("средняя") ? "good" : "neutral" }
    ];
    $("conditionCards").innerHTML = cards.map((x) => `<article class="condition-card tone-${x.tone}"><div class="condition-card-top"><span class="condition-icon">${x.icon}</span><span>${escapeHtml(x.label)}</span></div><strong>${escapeHtml(x.value)}</strong><p>${escapeHtml(x.detail)}</p></article>`).join("");
    const target = fishLabel(settings.fish); const reasons = [];
    if (c.wind >= 1.5 && c.wind <= 7) reasons.push("умеренная рябь помогает хищнику подойти к кромке"); else if (c.wind > 10) reasons.push("ветер добавляет риск и снижает точность подачи");
    if (c.pressureTrend > 1) reasons.push("давление растёт — модель добавляет короткое активное окно"); else if (c.pressureTrend < -3) reasons.push("давление падает — стоит чаще менять горизонт");
    if (dayPhaseScore(date) > .7) reasons.push(lightPhase(date) + " совпадает с суточным ритмом");
    if (c.rainProb > 65) reasons.push("осадки могут быстро изменить активность и видимость приманки");
    if (!reasons.length) reasons.push("условия ровные: рельеф и точность проводки важнее самой цифры");
    const best = l.hotspots.map((spot) => ({ spot, score: scoreAt(date, settings.fish, spot) })).sort((a, b) => b.score - a.score)[0];
    $("conditionsUpdated").textContent = weather ? "Open‑Meteo · сейчас" : "локальный сценарий";
    $("conditionsSummaryTitle").textContent = scoreLabel(score) + " · цель: " + target;
    $("conditionsNarrative").textContent = reasons.slice(0, 3).join("; ") + ".";
    $("conditionsAction").textContent = best ? "Стартовый план: " + best.spot.name + " (" + best.spot.depth + ") · " + best.spot.reason + ". Сделайте 3–5 забросов и промер перед сменой точки." : "Стартовый план: найдите первый перепад глубины и проверьте его промером.";
  }
  function renderFishGuide() {
    const l = lake(); const keys = l.fishKinds || []; const target = settings.fish; const date = new Date();
    const cards = keys.map((kind) => { const guide = fishGuide[kind]; if (!guide) return ""; const best = l.hotspots.map((spot) => scoreAt(date, kind, spot)).sort((a, b) => b - a)[0] || scoreAt(date, kind); return `<button class="fish-card ${target === kind ? "is-target" : ""}" type="button" data-fish-target="${kind}" aria-pressed="${String(target === kind)}"><div class="fish-card-head"><span class="fish-icon">${guide.icon}</span><span><strong>${escapeHtml(guide.label)}</strong><small>${escapeHtml(guide.tag)}</small></span><b>${best}</b></div><p class="fish-where"><span>Где</span>${escapeHtml(guide.where)} · ${escapeHtml(guide.depth)}</p><p class="fish-when"><span>Когда</span>${escapeHtml(guide.when)}</p><p class="fish-tactic"><span>Как</span>${escapeHtml(guide.tactic)}</p><p class="fish-why">${escapeHtml(guide.why)}</p><small class="fish-confidence">${escapeHtml(guide.confidence)} · нажмите, чтобы выбрать целью</small></button>`; }).filter(Boolean).join("");
    $("fishGuide").innerHTML = cards || `<p class="section-lead">Для этого водоёма пока нет карточек видов.</p>`;
    $("fishLakeNote").textContent = "" + keys.length + " ориентиров · уточняйте уловы и правила";
    qsa("[data-fish-target]").forEach((button) => button.addEventListener("click", () => { settings.fish = button.dataset.fishTarget; writeJson(SETTINGS_KEY, settings); renderAll(); showToast("Цель: " + fishLabel(settings.fish), 1600); }));
  }
  function bestWindows(count = 3) {
    const candidates = [];
    for (let d = 0; d < 2; d++) for (let h = 4; h <= 23; h++) { const date = new Date(); date.setDate(date.getDate() + d); date.setHours(h, 0, 0, 0); const score = scoreAt(date); candidates.push({ date, score }); }
    candidates.sort((a,b) => b.score - a.score); const picked = [];
    candidates.forEach((item) => { if (picked.length >= count) return; if (!picked.some((x) => Math.abs(x.date - item.date) < 3 * 3600000)) picked.push(item); });
    return picked.map((x) => ({ score: x.score, label: formatWindow(x.date), reason: x.date.getHours() < 11 ? "утреннее окно · первый свал" : x.date.getHours() > 17 ? "вечернее окно · кромка" : "дневное окно · течение" }));
  }
  function formatWindow(date) { const day = date.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" }); return day + " · " + String(date.getHours()).padStart(2,"0") + ":00–" + String((date.getHours() + 2) % 24).padStart(2,"0") + ":00"; }

  function renderCompare() {
    const scored = lakeKeys.map((key) => { const old = selectedLake; const oldWeather = weather; selectedLake = key; weather = weatherCache[key]?.data || (key === old ? oldWeather : null); const s = scoreAt(new Date()); const conf = confidence(); const l = lakes[key]; selectedLake = old; weather = oldWeather; return { key, score: s, confidence: conf, lake: l }; }).sort((a,b) => b.score - a.score);
    $("compareList").innerHTML = scored.map((item, index) => `<article class="compare-row ${index === 0 ? "is-best" : ""}"><div class="compare-row-head"><span class="lake-tab-dot dot-${item.key}"></span><strong>${escapeHtml(item.lake.name)}</strong></div><div class="compare-row-score"><strong>${item.score}</strong><span>${index === 0 ? "лучший шанс" : scoreLabel(item.score)}</span></div><div class="compare-bar"><i style="width:${item.score}%"></i></div><small>${escapeHtml(item.lake.depthLabel)} · ${item.confidence}% уверенность</small></article>`).join("");
    const weatherCount = lakeKeys.filter((key) => key === selectedLake ? !!weather : !!weatherCache[key]?.data).length;
    $("compareUpdated").textContent = weatherCount ? "погода · " + weatherCount + "/3 точек" : "локальная оценка";
    qsa("[data-mini-score]").forEach((el) => { const item = scored.find((x) => x.key === el.dataset.miniScore); el.textContent = item ? item.score : "—"; });
  }

  function renderForecast() {
    const l = lake(); const c = currentConditions(); const score = scoreAt(new Date());
    $("forecastIntro").textContent = "Почасовая оценка для " + l.name + "."; $("forecastScore").textContent = score; $("forecastScoreText").textContent = scoreLabel(score); $("forecastTemp").textContent = fmt(c.temperature, 0) + "°"; $("forecastWeatherText").textContent = weatherCodeText(c.code); $("forecastWeatherMeta").textContent = fmt(c.wind, 0) + " м/с · " + fmt(c.pressure, 0) + " гПа"; $("forecastConfidence").textContent = "уверенность " + confidence() + "%";
    const stats = [{ label: "ветер", value: fmt(c.wind, 0) + " м/с", note: directionName(c.direction) }, { label: "давление", value: fmt(c.pressure, 0) + " гПа", note: c.pressureTrend > 1 ? "растёт" : c.pressureTrend < -1 ? "падает" : "ровно" }, { label: "облачность", value: fmt(c.cloud, 0) + "%", note: c.cloud > 70 ? "много облаков" : "светлое небо" }, { label: "осадки", value: fmt(c.rainProb, 0) + "%", note: c.rainProb > 50 ? "возьмите дождевик" : "низкая вероятность" }, { label: "ощущается", value: fmt(c.apparent, 0) + "°", note: "влажность " + fmt(c.humidity, 0) + "%" }, { label: "осадков сейчас", value: fmt(c.precipitation, 1) + " мм", note: "по текущему часу" }];
    $("weatherStrip").innerHTML = stats.map((x) => `<div class="weather-stat"><span>${x.label}</span><strong>${x.value}</strong><small>${x.note}</small></div>`).join("");
    const hours = hourlyItems(); $("hourlyForecast").innerHTML = hours.map((x) => `<div class="hour-card ${x.best ? "is-best" : ""}"><time>${x.label}</time><span class="hour-icon">${weatherIcon(x.code, x.isDay)}</span><span class="hour-temp">${fmt(x.temp,0)}°</span><span class="hour-score">${x.score}</span><span class="hour-score-bar"><i style="width:${x.score}%"></i></span></div>`).join("");
    $("bestTimesList").innerHTML = bestWindows(3).map((x, i) => `<div class="best-time"><span class="best-time-rank">0${i + 1}</span><div><strong>${x.label}</strong><small>${x.reason}</small></div><b class="best-time-score">${x.score}</b></div>`).join("");
    renderForecastDetails(c, score);
  }
  function renderForecastDetails(c, score) {
    const date = new Date(); const l = lake(); const solar = solarHours(date); const fish = fishLabel(settings.fish); const targetGuide = settings.fish !== "universal" ? fishGuide[settings.fish] : null;
    const factors = [
      { label: "Световой ритм", value: Math.round(dayPhaseScore(date) * 100) + "/100", detail: lightPhase(date) + " · рассвет/закат задают основной пик", tone: dayPhaseScore(date) > .7 ? "good" : "neutral" },
      { label: "Ветер и рябь", value: fmt(c.wind, 0) + " м/с", detail: windDetail(c), tone: c.wind >= 1.5 && c.wind <= 7 ? "good" : c.wind > 10 ? "warn" : "neutral" },
      { label: "Давление", value: fmt(c.pressure, 0) + " гПа", detail: pressureDetail(c), tone: c.pressureTrend < -3 ? "warn" : "good" },
      { label: "Небо и осадки", value: fmt(c.cloud, 0) + "% / " + fmt(c.rainProb, 0) + "%", detail: weatherCodeText(c.code) + " · " + (c.rainProb > 50 ? "держите запасной берег" : "видимость приманки обычно комфортная"), tone: c.rainProb > 65 ? "warn" : "neutral" },
      { label: "Целевая рыба", value: fish, detail: targetGuide ? targetGuide.when + ". " + targetGuide.why : "выберите вид выше, чтобы усилить профиль условий", tone: targetGuide ? "good" : "neutral" },
      { label: "Локальная поправка", value: "+" + Math.min(8, journal.filter((entry) => entry.lake === selectedLake && entry.type === "catch").length * 1.5).toFixed(1), detail: "реальные уловы из журнала; сохраняются только на этом устройстве", tone: "neutral" }
    ];
    $("forecastFactors").innerHTML = factors.map((x) => `<article class="factor-row tone-${x.tone}"><div><strong>${escapeHtml(x.label)}</strong><p>${escapeHtml(x.detail)}</p></div><b>${escapeHtml(x.value)}</b></article>`).join("");
    $("forecastDecision").textContent = scoreLabel(score) + " · " + fish;
    $("forecastDetailNote").textContent = "Модель учитывает рассвет " + clockLabel(solar.sunrise) + ", закат " + clockLabel(solar.sunset) + ", лунный фон и рельеф " + l.depthLabel.toLowerCase() + ". На воде подтвердите точку эхолотом или промером.";
  }
  function hourlyItems() {
    const out = []; const base = new Date(); base.setMinutes(0,0,0); const candidates = [];
    for (let i = 0; i < 12; i++) { const date = new Date(base.getTime() + i * 3600000); const c = conditionsAt(date); candidates.push({ date, c, score: scoreAt(date) }); }
    const max = Math.max(...candidates.map((x) => x.score));
    candidates.forEach((x) => out.push({ label: x.date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }), temp: x.c.temperature, code: x.c.code, isDay: x.c.isDay, score: x.score, best: x.score === max })); return out;
  }
  function directionName(deg) { const dirs = ["С", "СВ", "В", "ЮВ", "Ю", "ЮЗ", "З", "СЗ"]; return dirs[Math.round((deg || 0) / 45) % 8]; }

  function renderJournal() {
    const entries = journal.slice().sort((a,b) => b.created - a.created); const lakeEntries = entries.filter((e) => e.lake === selectedLake);
    $("journalCount").textContent = lakeEntries.length; $("journalCatchCount").textContent = lakeEntries.filter((e) => e.type === "catch").length; $("journalMeasureCount").textContent = lakeEntries.filter((e) => e.type === "measure").length;
    $("journalEmpty").hidden = lakeEntries.length > 0;
    $("journalList").innerHTML = lakeEntries.map((entry) => `<article class="journal-entry"><span class="entry-icon">${entry.type === "catch" ? "✦" : entry.type === "measure" ? "⌁" : "⌖"}</span><div class="entry-main"><strong>${escapeHtml(entry.title || (entry.type === "catch" ? "Улов" : entry.type === "measure" ? "Промер" : "Точка"))}${entry.depth ? " · " + escapeHtml(entry.depth) + " м" : ""}</strong><small>${escapeHtml(entry.note || "без заметки")}${entry.fish ? " · " + escapeHtml(entry.fish) : ""}</small></div><span class="entry-meta">${new Date(entry.created).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}<br>${Number(entry.lat).toFixed(4)}, ${Number(entry.lon).toFixed(4)}</span><button class="entry-delete" type="button" data-delete-entry="${entry.id}">удалить</button></article>`).join("");
    qsa("[data-delete-entry]").forEach((button) => button.addEventListener("click", () => { journal = journal.filter((x) => x.id !== button.dataset.deleteEntry); writeJson(STORAGE_KEY, journal); renderAll(); showToast("Запись удалена", 1600); }));
  }
  function clearJournal() { if (!journal.length) return; if (!window.confirm("Удалить все локальные записи?")) return; journal = []; writeJson(STORAGE_KEY, journal); renderAll(); showToast("Журнал очищен", 1600); }
  function openPointModal(coords) {
    const focus = lake().focus || lake().center; const p = coords || { lat: focus[0], lon: focus[1] }; $("pointModal").hidden = false; $("pointLat").value = p.lat; $("pointLon").value = p.lon; $("pointLocation").textContent = "Координаты: " + Number(p.lat).toFixed(6) + ", " + Number(p.lon).toFixed(6); $("pointType").value = "measure"; $("pointDepth").value = ""; $("pointFish").value = ""; $("pointNote").value = ""; updatePointEstimate(); setTimeout(() => $("pointType").focus(), 0);
  }
  function closePointModal() { $("pointModal").hidden = true; }
  function updatePointEstimate() { const lat = Number($("pointLat").value), lon = Number($("pointLon").value); const est = estimateDepth(lat, lon); $("pointEstimate").textContent = "Оценка глубины по модели: " + (est ? "≈" + est.toFixed(1) + " м · низкая уверенность" : "—"); }
  function savePoint(event) { event.preventDefault(); const type = $("pointType").value; const id = window.crypto && typeof window.crypto.randomUUID === "function" ? window.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2); const entry = { id, lake: selectedLake, type, lat: Number($("pointLat").value), lon: Number($("pointLon").value), depth: $("pointDepth").value ? Number($("pointDepth").value) : null, fish: $("pointFish").value.trim(), note: $("pointNote").value.trim(), created: Date.now(), title: type === "catch" ? "Улов" : type === "measure" ? "Промер" : "Перспективная точка" }; journal.push(entry); writeJson(STORAGE_KEY, journal); closePointModal(); renderAll(); showToast("Сохранено только на этом iPhone", 2200); }

  function exportBlob(content, name, type) { const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 500); }
  function exportJson() { exportBlob(JSON.stringify({ exportedAt: new Date().toISOString(), entries: journal }, null, 2), "klev-ryadom-journal.json", "application/json"); showToast("JSON подготовлен", 1600); }
  function exportCsv() { const rows = [["дата","озеро","тип","широта","долгота","глубина_м","рыба","заметка"], ...journal.map((e) => [new Date(e.created).toISOString(), lakes[e.lake]?.name || e.lake, e.type, e.lat, e.lon, e.depth ?? "", e.fish || "", e.note || ""])]; exportBlob("\ufeff" + rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n"), "klev-ryadom-journal.csv", "text/csv;charset=utf-8"); showToast("CSV подготовлен", 1600); }

  function renderSources() { $("sourcesList").innerHTML = window.APP_SOURCES.map((x) => `<div class="source-row"><div><strong>${escapeHtml(x.label)}</strong><small>${escapeHtml(x.text)}</small></div><a href="${x.href}" target="_blank" rel="noreferrer" aria-label="Открыть источник">↗</a></div>`).join(""); }

  async function copyCoordinates() {
    const center = lake().center; const text = Number(center[0]).toFixed(6) + ", " + Number(center[1]).toFixed(6);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const input = document.createElement("textarea"); input.value = text; input.setAttribute("readonly", ""); input.style.position = "fixed"; input.style.opacity = "0"; document.body.appendChild(input); input.select(); document.execCommand("copy"); input.remove();
      }
      showToast("Координаты скопированы: " + text, 2200);
    } catch (_) { showToast("Координаты: " + text, 3200); }
  }

  function openSatellite() {
    const c = lake().center;
    const url = "https://www.google.com/maps/@?api=1&map_action=map&center=" + encodeURIComponent(c[0] + "," + c[1]) + "&zoom=" + (selectedLake === "sukhodol" ? "11" : "14") + "&basemap=satellite";
    showToast("Спутниковый слой открывается в Google Maps · нужна сеть", 2200);
    const popup = window.open(url, "_blank", "noopener,noreferrer");
    if (!popup) window.location.assign(url);
  }

  function updateZoomUi() {
    const reset = $("zoomReset"); if (!reset) return;
    if (viewMode === "hybrid" && leafletMap) { const z = leafletMap.getZoom(); reset.textContent = z.toFixed(1) + "×"; $("zoomOut").disabled = z <= 9; $("zoomIn").disabled = z >= 19; return; }
    reset.textContent = (mapState.scale <= 1.01 ? "1" : mapState.scale.toFixed(1)) + "×";
    $("zoomOut").disabled = mapState.scale <= 1.01;
    $("zoomIn").disabled = mapState.scale >= 3.99;
  }
  function constrainMapPan(width, height) {
    if (mapState.scale <= 1.001) { mapState.scale = 1; mapState.panX = 0; mapState.panY = 0; return; }
    const maxX = (mapState.scale - 1) * width * .62 + 14;
    const maxY = (mapState.scale - 1) * height * .62 + 14;
    mapState.panX = clamp(mapState.panX, -maxX, maxX); mapState.panY = clamp(mapState.panY, -maxY, maxY);
  }
  function resetMapView() { if (viewMode === "hybrid" && leafletMap) { const l = lake(); leafletMap.fitBounds(window.L.latLngBounds(l.geometry.map((p) => [p[0], p[1]])).pad(.08), { animate: true }); showMapToast("Масштаб сброшен", 1400); return; } mapState.scale = 1; mapState.panX = 0; mapState.panY = 0; drawMap(); showMapToast("Масштаб сброшен", 1400); }
  function zoomMap(factor, focal) {
    if (viewMode === "hybrid" && leafletMap) { const current = leafletMap.getZoom(); leafletMap.setZoom(clamp(current + Math.log2(factor), 9, 19), { animate: true }); return; }
    const canvas = $("lakeCanvas"); if (!canvas || !canvas.clientWidth) return;
    const rect = canvas.getBoundingClientRect(); const width = rect.width; const height = rect.height; const cx = width / 2; const cy = height / 2;
    const point = focal || { x: cx, y: cy }; const oldScale = mapState.scale; const nextScale = clamp(oldScale * factor, 1, 4);
    const anchorX = cx + (point.x - cx - mapState.panX) / oldScale; const anchorY = cy + (point.y - cy - mapState.panY) / oldScale;
    mapState.scale = nextScale; mapState.panX = point.x - cx - nextScale * (anchorX - cx); mapState.panY = point.y - cy - nextScale * (anchorY - cy);
    constrainMapPan(width, height); drawMap();
  }

  function projectPoint(lat, lon, width, height, bounds, pad = 24) {
    const x = pad + (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon || 1) * (width - pad * 2);
    const y = height - pad - (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat || 1) * (height - pad * 2); return { x, y };
  }
  function mapBounds() { const points = lake().geometry.concat(selectedLake === "sukhodol" ? window.BURNAYA_PATH : []); return { minLat: Math.min(...points.map((p) => p[0])), maxLat: Math.max(...points.map((p) => p[0])), minLon: Math.min(...points.map((p) => p[1])), maxLon: Math.max(...points.map((p) => p[1])) }; }
  function resizeCanvas() { const canvas = $("lakeCanvas"); if (!canvas || !canvas.clientWidth) return; const ratio = Math.min(window.devicePixelRatio || 1, 2); const w = Math.round(canvas.clientWidth * ratio), h = Math.round(canvas.clientHeight * ratio); canvas.dataset.pixelRatio = String(ratio); if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } if (viewMode === "hybrid") { resizeLeafletMap(); return; } drawMap(); }
  function ensureLeafletMap() {
    if (leafletMap || !window.L || !$("leafletMap")) return leafletMap;
    leafletMap = window.L.map("leafletMap", { zoomControl: true, attributionControl: true, preferCanvas: true, zoomSnap: .25, zoomDelta: .5, minZoom: 9, maxZoom: 19, inertia: true, tap: false });
    leafletBaseLayer = window.L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles © Esri" });
    leafletBaseLayer.addTo(leafletMap);
    leafletMap.on("zoomend moveend", () => { renderLeafletOverlays(); updateZoomUi(); });
    return leafletMap;
  }
  function loadLeafletLibrary() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletLibraryPromise) return leafletLibraryPromise;
    leafletLibraryPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-leaflet-fallback]'); if (existing) { existing.addEventListener("load", () => resolve(window.L), { once: true }); existing.addEventListener("error", reject, { once: true }); return; }
      const script = document.createElement("script"); script.src = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"; script.crossOrigin = "anonymous"; script.dataset.leafletFallback = "true"; script.onload = () => resolve(window.L); script.onerror = reject; document.head.appendChild(script);
    });
    return leafletLibraryPromise;
  }
  function resizeLeafletMap() { if (!leafletMap) return; leafletMap.invalidateSize({ pan: false }); renderLeafletOverlays(); }
  function clearLeafletLayers() { leafletLayers.forEach((layer) => layer.remove()); leafletLayers = []; }
  function depthLabelIcon(level) { return window.L.divIcon({ className: "depth-label-marker", html: `<span>${escapeHtml(depthText(level))}</span>`, iconSize: [1, 1], iconAnchor: [0, 0] }); }
  function renderLeafletOverlays() {
    if (!leafletMap || viewMode !== "hybrid") return;
    clearLeafletLayers(); const l = lake(); const levels = depthVisible ? (l.contourLevels || []).map(Number).filter(Number.isFinite) : []; const coords = l.geometry.map((p) => [p[0], p[1]]);
    const boundary = window.L.polygon(coords, { color: "#a5efd0", weight: 2, opacity: .88, fillColor: "#4fb89d", fillOpacity: .16, interactive: false }).addTo(leafletMap); leafletLayers.push(boundary);
    levels.forEach((level, index) => {
      const fraction = clamp(.16 + .74 * (level / Math.max(...levels, 1)), .16, .94); const center = l.geometry.reduce((a, p) => [a[0] + p[0] / l.geometry.length, a[1] + p[1] / l.geometry.length], [0, 0]); const ring = l.geometry.map((p) => [center[0] + (p[0] - center[0]) * fraction, center[1] + (p[1] - center[1]) * fraction]);
      const contour = window.L.polyline(ring, { color: index === levels.length - 1 ? "#b8f5db" : "#d5f4e7", weight: 1, opacity: .58, interactive: false }).addTo(leafletMap); leafletLayers.push(contour);
      const anchor = ring[Math.floor(ring.length * (.14 + index * .008)) % ring.length]; const marker = window.L.marker(anchor, { icon: depthLabelIcon(level), interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(leafletMap); leafletLayers.push(marker);
    });
    if (selectedLake === "sukhodol") { const river = window.L.polyline(window.BURNAYA_PATH.map((p) => [p[0], p[1]]), { color: "#f3d889", weight: 3, dashArray: "7 5", opacity: .9, interactive: false }).addTo(leafletMap); leafletLayers.push(river); }
    if (zonesVisible) {
      const ranked = rankedHotspots(settings.fish); const rankById = new Map(ranked.map((item, index) => [item.spot.id, { ...item, rank: index + 1 }]));
      (l.hotspots || []).forEach((spot) => { const item = rankById.get(spot.id); const rank = item?.rank || 99; const selected = settings.fish !== "universal"; const top = rank <= 3; const marker = window.L.circleMarker([spot.lat, spot.lon], { radius: selected && top ? 9 : 6, color: selected && top ? "#f3d889" : "#e4cd7d", weight: selected && rank === 1 ? 3 : 1.5, fillColor: "#f3d889", fillOpacity: selected && top ? .72 : .35, interactive: true }).addTo(leafletMap); marker.bindTooltip(`${selected ? rank + ". " : ""}${escapeHtml(spot.name)} · ${escapeHtml(spot.depth)}`, { direction: "top", opacity: .92 }); marker.on("click", () => showMapToast(spot.name + " · " + spot.depth + " · " + spot.species + " · шанс " + scoreAt(new Date(), settings.fish, spot))); leafletLayers.push(marker); });
    }
  }
  function syncMapSurface() {
    const canvas = $("lakeCanvas"); const surface = $("leafletMap"); const hybrid = viewMode === "hybrid";
    canvas.hidden = hybrid; surface.hidden = !hybrid;
    if (hybrid) { const map = ensureLeafletMap(); if (!map) { loadLeafletLibrary().then(() => { if (viewMode === "hybrid") syncMapSurface(); }).catch(() => { canvas.hidden = false; surface.hidden = true; showToast("Гибридный слой недоступен — показываю офлайн-карту", 2600); drawMap(); }); return; } const l = lake(); const bounds = window.L.latLngBounds(l.geometry.map((p) => [p[0], p[1]])); const sameLake = map._klevLakeKey === selectedLake; map._klevLakeKey = selectedLake; if (!sameLake) map.fitBounds(bounds.pad(.08), { animate: false }); setTimeout(() => { map.invalidateSize({ pan: false }); renderLeafletOverlays(); updateZoomUi(); }, 0); }
    else { drawMap(); }
  }
  function drawMap() {
    const canvas = $("lakeCanvas"); if (!canvas || !canvas.clientWidth) return; const ctx = canvas.getContext("2d"); const ratio = Number(canvas.dataset.pixelRatio || 1); const w = canvas.clientWidth, h = canvas.clientHeight; constrainMapPan(w, h); ctx.setTransform(ratio,0,0,ratio,0,0); ctx.clearRect(0,0,w,h); const bounds = mapBounds();
    drawMapBackground(ctx,w,h); const base = lake().geometry.map((p) => projectPoint(p[0],p[1],w,h,bounds,34)); drawLand(ctx,w,h,bounds);
    ctx.save(); if (viewMode === "3d") applyTerrainTransform(ctx,w,h); const cx=w/2,cy=h/2; ctx.translate(cx + mapState.panX, cy + mapState.panY); ctx.scale(mapState.scale, mapState.scale); ctx.translate(-cx,-cy);
    if (viewMode === "3d") { drawTerrainShadow(ctx,base,w,h); drawTerrainGrid(ctx,w,h,base); } drawWater(ctx,base,viewMode === "3d"); if (depthVisible) drawDepthBands(ctx,base,viewMode === "3d",w,h); if (selectedLake === "sukhodol") drawRiver(ctx,bounds); if (zonesVisible) drawHotspots(ctx,bounds); drawJournalPoints(ctx,w,h,bounds); if (mapState.user) drawUser(ctx, projectPoint(mapState.user.lat,mapState.user.lon,w,h,bounds,34)); if (depthVisible) drawDepthLabels(ctx,base,viewMode === "3d",w,h); ctx.restore(); updateZoomUi();
  }
  function drawMapBackground(ctx,w,h) { const g = ctx.createLinearGradient(0,0,w,h); g.addColorStop(0,"#12353a"); g.addColorStop(1,"#071d23"); ctx.fillStyle=g;ctx.fillRect(0,0,w,h); ctx.strokeStyle="rgba(159,231,199,.07)";ctx.lineWidth=1; const step=Math.max(40,w/14); for(let x=0;x<w;x+=step){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();} for(let y=0;y<h;y+=step){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();} }
  function drawLand(ctx,w,h,bounds) { ctx.fillStyle="rgba(31,69,56,.45)"; ctx.fillRect(0,0,w,h); ctx.fillStyle="rgba(83,125,89,.12)"; for(let i=0;i<18;i++){const x=(i*173)%w,y=(i*97)%h;ctx.beginPath();ctx.arc(x,y,7+(i%4)*3,0,Math.PI*2);ctx.fill();} }
  function pathPolygon(ctx,points) { ctx.beginPath(); points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath(); }
  function applyTerrainTransform(ctx,w,h) { const tilt = .64; const offset = Math.min(64, Math.max(34, h * .14)); ctx.translate(w / 2, h / 2 + offset); ctx.scale(1, tilt); ctx.translate(-w / 2, -h / 2); }
  function terrainInverseY(y,h) { const tilt = .64; const offset = Math.min(64, Math.max(34, h * .14)); return h / 2 + (y - h / 2 - offset) / tilt; }
  function drawTerrainShadow(ctx,points,w,h) { ctx.save(); ctx.globalAlpha = .28; for (let i = 8; i >= 1; i--) { pathPolygon(ctx, points.map((p) => ({ x: p.x, y: p.y + i * 4 }))); ctx.fillStyle = `rgba(0,10,15,${.035 + i * .012})`; ctx.fill(); } ctx.globalAlpha = .5; pathPolygon(ctx, points.map((p) => ({ x: p.x, y: p.y + 34 }))); ctx.strokeStyle = "rgba(1,13,18,.65)"; ctx.lineWidth = 2; ctx.stroke(); ctx.restore(); }
  function drawWater(ctx,points,tilted) { pathPolygon(ctx,points); const g=ctx.createLinearGradient(0,0,0,ctx.canvas.height); g.addColorStop(0, tilted ? "rgba(136,211,220,.78)" : "rgba(72,153,171,.62)");g.addColorStop(.42, tilted ? "rgba(49,128,151,.78)" : "rgba(39,116,139,.67)");g.addColorStop(1,"rgba(12,54,76,.88)");ctx.fillStyle=g;ctx.fill();ctx.strokeStyle=tilted ? "rgba(203,249,232,.92)" : "rgba(159,231,199,.78)";ctx.lineWidth=tilted ? 2.4 : 2;ctx.stroke(); if(tilted){ctx.save();ctx.globalAlpha=.32;pathPolygon(ctx,points.map((p)=>({x:p.x,y:p.y-2})));ctx.strokeStyle="#e3fff4";ctx.lineWidth=1;ctx.stroke();ctx.restore();} }
  function depthCenter(points) { return points.reduce((a,p) => ({ x: a.x + p.x / points.length, y: a.y + p.y / points.length }), { x: 0, y: 0 }); }
  function depthContours(points) {
    if (!Array.isArray(points) || points.length < 3) return [];
    const levels = (lake().contourLevels || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b); if (!levels.length) return [];
    const center = depthCenter(points); const max = Math.max(...levels, 1);
    return levels.map((level) => {
      const t = clamp(level / max, 0, 1); const f = clamp(.16 + .74 * t, .16, .94);
      return { level, t, ring: points.map((p) => ({ x: center.x + (p.x - center.x) * f, y: center.y + (p.y - center.y) * f })) };
    });
  }
  function drawDepthBands(ctx, points, tilted = false) {
    const contours = depthContours(points); if (!contours.length) return;
    contours.slice().reverse().forEach((contour) => {
      pathPolygon(ctx, contour.ring);
      const alpha = (tilted ? .12 : .075) + contour.t * (tilted ? .11 : .075);
      ctx.fillStyle = `rgba(${Math.round(54 - contour.t * 27)},${Math.round(137 - contour.t * 43)},${Math.round(159 + contour.t * 20)},${alpha.toFixed(3)})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(210,250,235,${((tilted ? .24 : .16) + contour.t * .2).toFixed(3)})`;
      ctx.lineWidth = tilted ? 1.35 : 1.1; ctx.stroke();
    });
  }
  function roundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + width - r, y); ctx.quadraticCurveTo(x + width, y, x + width, y + r); ctx.lineTo(x + width, y + height - r); ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height); ctx.lineTo(x + r, y + height); ctx.quadraticCurveTo(x, y + height, x, y + height - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function pointOnPolygon(ring, fraction) {
    if (!ring?.length) return { x: 0, y: 0 };
    let total = 0; const lengths = ring.map((p, i) => { const q = ring[(i + 1) % ring.length]; const len = Math.hypot(q.x - p.x, q.y - p.y); total += len; return len; });
    let target = ((fraction % 1) + 1) % 1 * total;
    for (let i = 0; i < ring.length; i++) { const p = ring[i]; const q = ring[(i + 1) % ring.length]; const len = lengths[i] || 1; if (target <= len) { const k = target / len; return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k }; } target -= len; }
    return ring[0];
  }
  function drawDepthLabels(ctx, points, tilted = false, width, height) {
    const contours = depthContours(points); if (!contours.length) return;
    const center = depthCenter(points); const fontSize = clamp((width || 360) / 105, 7, 9.5); const mapWidth = width || 360; const mapHeight = height || 280;
    ctx.save(); ctx.font = `500 ${fontSize.toFixed(1)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    contours.forEach((contour, index) => {
      // Quiet, background-free label anchored to the matching contour.
      const anchor = pointOnPolygon(contour.ring, .14 + index * .008); const vx = anchor.x - center.x; const vy = anchor.y - center.y; const distance = Math.hypot(vx, vy) || 1; const offset = clamp(fontSize * .45, 2, 4); const label = depthText(contour.level);
      const x = clamp(anchor.x + vx / distance * offset, 8, mapWidth - 8); const y = clamp(anchor.y + vy / distance * offset, 7, mapHeight - 7);
      ctx.save(); ctx.fillStyle = index === contours.length - 1 ? "rgba(225,250,239,.78)" : "rgba(225,245,237,.62)"; ctx.fillText(label, x, y + .2); ctx.restore();
    });
    ctx.restore();
  }
  function drawTerrainGrid(ctx,w,h,points) { ctx.save();ctx.globalAlpha=.32;ctx.strokeStyle="#d0f5e9";ctx.lineWidth=1;const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y)); for(let i=0;i<9;i++){const y=minY+(maxY-minY)*i/8;ctx.beginPath();ctx.moveTo(minX-20,y);ctx.lineTo(maxX+20,y-42-i*2);ctx.stroke();} for(let i=0;i<11;i++){const x=minX+(maxX-minX)*i/10;ctx.beginPath();ctx.moveTo(x,minY-8);ctx.lineTo(x-42,maxY+8);ctx.stroke();} ctx.globalAlpha=.24; ctx.strokeStyle="#0a3245"; for(let i=0;i<5;i++){const y=minY+(maxY-minY)*(.14+i*.18);ctx.beginPath();ctx.moveTo(minX,y);ctx.quadraticCurveTo((minX+maxX)/2,y-18,maxX,y-34);ctx.stroke();}ctx.restore(); }
  function drawRiver(ctx,bounds) { const w=ctx.canvas.clientWidth||ctx.canvas.width, h=ctx.canvas.clientHeight||ctx.canvas.height; const path=window.BURNAYA_PATH.map((p)=>projectPoint(p[0],p[1],w,h,bounds,34)); ctx.save();ctx.strokeStyle="#f3d889";ctx.globalAlpha=.8;ctx.lineWidth=3;ctx.setLineDash([7,5]);ctx.beginPath();path.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();ctx.setLineDash([]);ctx.fillStyle="#f3d889";ctx.font="11px -apple-system, sans-serif";const mid=path[Math.floor(path.length/2)];ctx.fillText("р. Бурная · проверьте правила",mid.x+8,mid.y-8);ctx.restore(); }
  function drawHotspots(ctx,bounds) {
    const w = ctx.canvas.clientWidth || ctx.canvas.width, h = ctx.canvas.clientHeight || ctx.canvas.height; const ranked = rankedHotspots(settings.fish); const rankById = new Map(ranked.map((item, index) => [item.spot.id, { ...item, rank: index + 1 }]));
    ctx.save(); (lake().hotspots || []).forEach((spot) => {
      const item = rankById.get(spot.id); const p = projectPoint(spot.lat, spot.lon, w, h, bounds, 34); const rank = item?.rank || 99; const score = item?.score || scoreAt(new Date(), settings.fish, spot); const selected = settings.fish !== "universal"; const isTop = rank <= 3; const r = Math.max(selected ? (isTop ? 22 : 14) : 16, w / (selected && isTop ? 42 : 52));
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fillStyle = selected && isTop ? (rank === 1 ? "rgba(243,216,137,.3)" : "rgba(243,216,137,.17)") : "rgba(243,216,137,.12)"; ctx.fill(); ctx.strokeStyle = selected && isTop ? "rgba(243,216,137,.95)" : "rgba(243,216,137,.48)"; ctx.setLineDash(selected && isTop ? [] : [3, 3]); ctx.lineWidth = selected && rank === 1 ? 2.2 : 1.2; ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(p.x, p.y, selected && isTop ? 6 : 4, 0, Math.PI * 2); ctx.fillStyle = selected && rank === 1 ? "#fff0a8" : "#f3d889"; ctx.fill();
      if (selected && isTop) { ctx.font = `700 ${Math.max(10, Math.min(13, w / 75)).toFixed(1)}px -apple-system, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#07181d"; ctx.fillText(String(rank), p.x, p.y + .5); }
      if (selected ? isTop : (rank === 1 || w > 650)) { const label = selected ? `${rank}. ${spot.name} · ${score}` : `${spot.name} · ${score}`; ctx.font = "600 10px -apple-system, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; const lx = clamp(p.x + r + 5, 6, w - Math.min(185, w * .48)); const ly = clamp(p.y, 15, h - 15); const tw = ctx.measureText(label).width + 10; roundedRectPath(ctx, lx - 4, ly - 9, tw, 18, 4); ctx.fillStyle = "rgba(3,18,23,.86)"; ctx.fill(); ctx.fillStyle = "#effff7"; ctx.fillText(label, lx + 1, ly + .5); }
    }); ctx.restore();
  }
  function drawUser(ctx,p) { ctx.save();ctx.beginPath();ctx.arc(p.x,p.y,10,0,Math.PI*2);ctx.fillStyle="#65cfe0";ctx.fill();ctx.strokeStyle="#e9ffff";ctx.lineWidth=2;ctx.stroke();ctx.beginPath();ctx.arc(p.x,p.y,18,0,Math.PI*2);ctx.strokeStyle="rgba(101,207,224,.45)";ctx.lineWidth=2;ctx.stroke();ctx.restore(); }
  function drawJournalPoints(ctx,w,h,bounds) { const entries=journal.filter((entry)=>entry.lake===selectedLake); if(!entries.length)return; ctx.save(); entries.forEach((entry)=>{const p=projectPoint(entry.lat,entry.lon,w,h,bounds,34);ctx.beginPath();ctx.arc(p.x,p.y,5,0,Math.PI*2);ctx.fillStyle=entry.type==="catch"?"#f17973":"#65cfe0";ctx.fill();ctx.strokeStyle="#07181d";ctx.lineWidth=2;ctx.stroke();}); ctx.restore(); }
  function estimateDepth(lat,lon) { const c=lake().focus || lake().center; const dx=(lon-c[1])*111320*Math.cos(c[0]*Math.PI/180),dy=(lat-c[0])*111320; const d=Math.sqrt(dx*dx+dy*dy); const max=lake().maxDepth; return clamp(max*(.18+.82*(1-Math.min(1,d/1200))), .7, max); }
  function pointerDistance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function pointerCenter(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function mapPointerDown(event) {
    const canvas = event.currentTarget; try { canvas.setPointerCapture?.(event.pointerId); } catch (_) {} activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size === 1) { mapGesture = { type: "pan", pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: false, multi: false }; return; }
    if (activePointers.size >= 2) {
      const points = Array.from(activePointers.values()).slice(0, 2); const center = pointerCenter(points[0], points[1]);
      mapGesture = { type: "pinch", startDistance: Math.max(1, pointerDistance(points[0], points[1])), startCenter: center, startScale: mapState.scale, startPanX: mapState.panX, startPanY: mapState.panY, multi: true };
    }
  }
  function mapPointerMove(event) {
    if (!activePointers.has(event.pointerId)) return; activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const canvas = event.currentTarget; const rect = canvas.getBoundingClientRect(); const width = rect.width, height = rect.height;
    if (activePointers.size >= 2 && mapGesture?.type === "pinch") {
      const points = Array.from(activePointers.values()).slice(0, 2); const center = pointerCenter(points[0], points[1]); const distance = Math.max(1, pointerDistance(points[0], points[1])); const startX = mapGesture.startCenter.x - rect.left, startY = mapGesture.startCenter.y - rect.top; const currentX = center.x - rect.left, currentY = center.y - rect.top; const cx = width / 2, cy = height / 2; const anchorX = cx + (startX - cx - mapGesture.startPanX) / mapGesture.startScale; const anchorY = cy + (startY - cy - mapGesture.startPanY) / mapGesture.startScale;
      mapState.scale = clamp(mapGesture.startScale * distance / mapGesture.startDistance, 1, 4); mapState.panX = currentX - cx - mapState.scale * (anchorX - cx); mapState.panY = currentY - cy - mapState.scale * (anchorY - cy); constrainMapPan(width, height); drawMap(); return;
    }
    if (activePointers.size === 1 && mapGesture?.type === "pan" && mapGesture.pointerId === event.pointerId) {
      const dx = event.clientX - mapGesture.lastX, dy = event.clientY - mapGesture.lastY; if (Math.abs(dx) + Math.abs(dy) > 5) mapGesture.moved = true;
      if (mapGesture.moved && mapState.scale > 1) { mapState.panX += dx; mapState.panY += dy; constrainMapPan(width, height); drawMap(); }
      mapGesture.lastX = event.clientX; mapGesture.lastY = event.clientY;
    }
  }
  function mapPointerUp(event) {
    const wasGesture = mapGesture; const wasMulti = Boolean(wasGesture?.multi || wasGesture?.type === "pinch"); activePointers.delete(event.pointerId); try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch (_) {}
    if (activePointers.size === 1) { const remaining = Array.from(activePointers.entries())[0]; if (wasMulti) mapGesture = { type: "pan", pointerId: remaining[0], lastX: remaining[1].x, lastY: remaining[1].y, moved: true, multi: true }; return; }
    if (activePointers.size > 1) return;
    if (!wasMulti && wasGesture?.type === "pan" && !wasGesture.moved) handleMapTap(event);
    mapGesture = null;
  }
  function handleMapTap(event) {
    const rect = event.currentTarget.getBoundingClientRect(); const bounds = mapBounds(); const x = event.clientX - rect.left, y = event.clientY - rect.top; const p = unprojectPoint(x, y, rect.width, rect.height, bounds, 34); const hotspot = nearestHotspot(p.lat, p.lon, rect.width, rect.height, bounds);
    if (hotspot) showMapToast(hotspot.name + " · " + hotspot.depth + " · " + hotspot.species + " · шанс " + scoreAt(new Date(), settings.fish, hotspot)); else if (pointInPolygon([p.lat, p.lon], lake().geometry)) openPointModal(p); else showMapToast("Точка вне контура воды — приблизьте карту к берегу");
  }
  function unprojectPoint(x,y,w,h,bounds,pad=24) { let screenY = y; if (viewMode === "3d") screenY = terrainInverseY(screenY, h); const cx=w/2,cy=h/2; const rawX=(x-cx-mapState.panX)/mapState.scale+cx; const rawY=(screenY-cy-mapState.panY)/mapState.scale+cy; return { lon: bounds.minLon + clamp((rawX-pad)/(w-pad*2),0,1)*(bounds.maxLon-bounds.minLon), lat: bounds.minLat + clamp((h-pad-rawY)/(h-pad*2),0,1)*(bounds.maxLat-bounds.minLat) }; }
  function pointInPolygon(point, polygon) { const lat=point[0],lon=point[1]; let inside=false; for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const yi=polygon[i][0],xi=polygon[i][1],yj=polygon[j][0],xj=polygon[j][1]; const intersect=((xi>lon)!=(xj>lon)) && (lat < (yj-yi)*(lon-xi)/(xj-xi || 1e-12)+yi); if(intersect) inside=!inside;} return inside; }
  function nearestHotspot(lat,lon,w,h,bounds) { let best=null,bestPx=Infinity; lake().hotspots.forEach((spot)=>{const p=projectPoint(spot.lat,spot.lon,w,h,bounds,34); const q=projectPoint(lat,lon,w,h,bounds,34); const d=Math.hypot(p.x-q.x,p.y-q.y); if(d<bestPx){bestPx=d;best=spot;}}); return bestPx<Math.max(24,w*.07) ? best : null; }
  let mapToastTimer=null;
  function showMapToast(message) { const el=$("mapToast"); el.textContent=message; el.hidden=false; clearTimeout(mapToastTimer); mapToastTimer=setTimeout(()=>{el.hidden=true;},3600); }
  function locateUser() { if(!navigator.geolocation){showToast("Геолокация не поддерживается");return;} showToast("Запрашиваю местоположение…",1800);navigator.geolocation.getCurrentPosition((pos)=>{mapState.user={lat:pos.coords.latitude,lon:pos.coords.longitude}; if (viewMode === "hybrid" && leafletMap) leafletMap.setView([pos.coords.latitude, pos.coords.longitude], Math.max(leafletMap.getZoom(), 14), { animate: true }); else drawMap();showToast("Синяя точка — ваше местоположение",2200);},()=>showToast("Разрешите геолокацию в настройках Safari"),{enableHighAccuracy:true,timeout:8000}); }

  function registerServiceWorker() { if("serviceWorker" in navigator){navigator.serviceWorker.register("sw.js?v=20260901-hybrid-calm-4", { updateViaCache: "none" }).catch(()=>{});} }
  function boot() { setupNavigation(); $("fishSelect").value=settings.fish; navigate(location.hash.slice(1)||"map",false); setConnection(isOnline()?"online":"offline",isOnline()?"онлайн":"локально"); renderSources(); renderAll(); fetchWeather(false); registerServiceWorker(); }
  document.addEventListener("DOMContentLoaded", boot);
})();
