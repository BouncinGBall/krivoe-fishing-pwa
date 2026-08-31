(function () {
  "use strict";

  const lakes = window.LAKE_DATA;
  const lakeKeys = Object.keys(lakes);
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
  let depthVisible = true;
  let zonesVisible = true;
  let mapState = { scale: 1, panX: 0, panY: 0, user: null };
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
    $("mode3d").addEventListener("click", () => setMode("3d"));
    $("depthToggle").addEventListener("click", () => { depthVisible = !depthVisible; updateToggle($("depthToggle"), depthVisible); drawMap(); });
    $("zonesToggle").addEventListener("click", () => { zonesVisible = !zonesVisible; updateToggle($("zonesToggle"), zonesVisible); drawMap(); });
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
    canvas.addEventListener("wheel", (event) => { event.preventDefault(); mapState.scale = clamp(mapState.scale * (event.deltaY > 0 ? .92 : 1.08), 1, 3); drawMap(); }, { passive: false });
  }

  function navigate(target, push = true) {
    if (!/[a-z]+/.test(target) || !["map", "forecast", "journal", "about"].includes(target)) target = "map";
    if (target !== "map" && $("pointModal")) closePointModal();
    qsa(".screen").forEach((screen) => { const active = screen.dataset.screen === target; screen.hidden = !active; screen.classList.toggle("is-active", active); });
    qsa(".nav-item").forEach((button) => { const active = button.dataset.screenTarget === target; button.classList.toggle("is-active", active); if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
    if (push && location.hash !== "#" + target) history.pushState({}, "", "#" + target);
    if (target === "map") requestAnimationFrame(resizeCanvas);
    if (target === "journal") renderJournal();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function selectLake(key) {
    if (!lakes[key]) return;
    selectedLake = key; mapState.scale = 1; mapState.panX = 0; mapState.panY = 0; mapState.user = null; weather = null; weatherError = false; restoreWeatherCache(key);
    qsa(".lake-tab").forEach((button) => { const active = button.dataset.lake === key; button.classList.toggle("is-selected", active); button.setAttribute("aria-selected", String(active)); });
    renderAll();
    showToast(lakes[key].name + " · карта обновлена", 1800); fetchWeather(false);
  }

  function setMode(mode) {
    viewMode = mode;
    $("mode2d").classList.toggle("is-active", mode === "2d"); $("mode2d").setAttribute("aria-pressed", String(mode === "2d"));
    $("mode3d").classList.toggle("is-active", mode === "3d"); $("mode3d").setAttribute("aria-pressed", String(mode === "3d"));
    $("mapModeLabel").textContent = mode === "3d" ? "3D · модельный рельеф" : "2D · модельная батиметрия";
    drawMap();
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
    return { temperature: 15 + seasonal * 4, wind: 3.5, direction: 220, pressure: 1014, cloud: 45, rainProb: 12, code: 2, isDay: hour >= 5 && hour < 22 };
  }
  function currentConditions() {
    if (weather && weather.current) {
      const c = weather.current;
      const pNow = Number(c.pressure_msl ?? 1014); const pBefore = weather?.hourly?.pressure_msl ? Number(weather.hourly.pressure_msl[Math.max(0, nearestHourIndex(weather.hourly.time) - 3)] ?? pNow) : pNow;
      return { temperature: c.temperature_2m, wind: c.wind_speed_10m, direction: c.wind_direction_10m, pressure: pNow, pressureTrend: pNow - pBefore, cloud: c.cloud_cover, rainProb: currentHourly("precipitation_probability"), code: c.weather_code, isDay: c.is_day };
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
    if (kind === "burbot") return clamp(.64 + (temp < 12 ? .2 : 0) + (hour >= 19 || hour <= 5 ? .12 : 0), .3, 1);
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
      burbot: { krivoe: -1, ulovnoe: 7, sukhodol: 2 }
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
    renderMapMeta(); renderBestWindow(); renderBestZone(); renderCompare(); renderForecast(); renderJournal(); renderSources(); resizeCanvas();
    $("fishSelect").value = settings.fish;
  }

  function renderMapMeta() {
    const l = lake(); const center = l.center; $("mapHint").textContent = viewMode === "3d" ? "Наклонённая схема · глубины смоделированы" : "Нажмите на карту, чтобы поставить точку"; $("mapScale").textContent = l.area + " · максимум " + l.maxDepth + " м"; $("copyCoordinates").textContent = "коорд.: " + Number(center[0]).toFixed(6) + ", " + Number(center[1]).toFixed(6);
  }
  function renderBestWindow() {
    const windows = bestWindows(3); const first = windows[0];
    $("bestWindow").textContent = first ? first.label : "проверьте рассвет"; $("bestWindowReason").textContent = first ? first.reason : "Сеть недоступна — используйте локальный ориентир"; $("bestWindowScore").textContent = first ? first.score + "/100" : "—";
  }
  function renderBestZone() {
    const l = lake(); const best = l.hotspots.map((spot) => ({ spot, score: scoreAt(new Date(), settings.fish, spot) })).sort((a, b) => b.score - a.score)[0];
    $("bestZone").textContent = best ? best.spot.name : "первый свал"; $("bestZoneMeta").textContent = best ? best.spot.depth + " · " + best.spot.species : "модельная перспективная зона"; $("bestZoneScore").textContent = best ? best.score + "/100" : "—";
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
    const stats = [{ label: "ветер", value: fmt(c.wind, 0) + " м/с", note: directionName(c.direction) }, { label: "давление", value: fmt(c.pressure, 0) + " гПа", note: c.pressureTrend > 1 ? "растёт" : c.pressureTrend < -1 ? "падает" : "ровно" }, { label: "облачность", value: fmt(c.cloud, 0) + "%", note: c.cloud > 70 ? "много облаков" : "светлое небо" }, { label: "осадки", value: fmt(c.rainProb, 0) + "%", note: c.rainProb > 50 ? "возьмите дождевик" : "низкая вероятность" }];
    $("weatherStrip").innerHTML = stats.map((x) => `<div class="weather-stat"><span>${x.label}</span><strong>${x.value}</strong><small>${x.note}</small></div>`).join("");
    const hours = hourlyItems(); $("hourlyForecast").innerHTML = hours.map((x) => `<div class="hour-card ${x.best ? "is-best" : ""}"><time>${x.label}</time><span class="hour-icon">${weatherIcon(x.code, x.isDay)}</span><span class="hour-temp">${fmt(x.temp,0)}°</span><span class="hour-score">${x.score}</span><span class="hour-score-bar"><i style="width:${x.score}%"></i></span></div>`).join("");
    $("bestTimesList").innerHTML = bestWindows(3).map((x, i) => `<div class="best-time"><span class="best-time-rank">0${i + 1}</span><div><strong>${x.label}</strong><small>${x.reason}</small></div><b class="best-time-score">${x.score}</b></div>`).join("");
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

  function projectPoint(lat, lon, width, height, bounds, pad = 24) {
    const x = pad + (lon - bounds.minLon) / (bounds.maxLon - bounds.minLon || 1) * (width - pad * 2);
    const y = height - pad - (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat || 1) * (height - pad * 2); return { x, y };
  }
  function mapBounds() { const points = lake().geometry.concat(selectedLake === "sukhodol" ? window.BURNAYA_PATH : []); return { minLat: Math.min(...points.map((p) => p[0])), maxLat: Math.max(...points.map((p) => p[0])), minLon: Math.min(...points.map((p) => p[1])), maxLon: Math.max(...points.map((p) => p[1])) }; }
  function resizeCanvas() { const canvas = $("lakeCanvas"); if (!canvas || !canvas.clientWidth) return; const ratio = Math.min(window.devicePixelRatio || 1, 2); const w = Math.round(canvas.clientWidth * ratio), h = Math.round(canvas.clientHeight * ratio); canvas.dataset.pixelRatio = String(ratio); if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } drawMap(); }
  function drawMap() {
    const canvas = $("lakeCanvas"); if (!canvas || !canvas.clientWidth) return; const ctx = canvas.getContext("2d"); const ratio = Number(canvas.dataset.pixelRatio || 1); const w = canvas.clientWidth, h = canvas.clientHeight; ctx.setTransform(ratio,0,0,ratio,0,0); ctx.clearRect(0,0,w,h); const bounds = mapBounds();
    drawMapBackground(ctx,w,h); const base = lake().geometry.map((p) => projectPoint(p[0],p[1],w,h,bounds,34));
    ctx.save(); const cx=w/2,cy=h/2; ctx.translate(cx + mapState.panX * (w/900), cy + mapState.panY * (h/560)); ctx.scale(mapState.scale, mapState.scale); ctx.translate(-cx,-cy);
    drawLand(ctx,w,h,bounds); if (viewMode === "3d") drawTerrainGrid(ctx,w,h,base); drawWater(ctx,base,viewMode === "3d"); if (depthVisible) drawDepthBands(ctx,base); if (selectedLake === "sukhodol") drawRiver(ctx,bounds); if (zonesVisible) drawHotspots(ctx,bounds); drawJournalPoints(ctx,w,h,bounds); if (mapState.user) drawUser(ctx, projectPoint(mapState.user.lat,mapState.user.lon,w,h,bounds,34)); ctx.restore();
  }
  function drawMapBackground(ctx,w,h) { const g = ctx.createLinearGradient(0,0,w,h); g.addColorStop(0,"#12353a"); g.addColorStop(1,"#071d23"); ctx.fillStyle=g;ctx.fillRect(0,0,w,h); ctx.strokeStyle="rgba(159,231,199,.07)";ctx.lineWidth=1; const step=Math.max(40,w/14); for(let x=0;x<w;x+=step){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();} for(let y=0;y<h;y+=step){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();} }
  function drawLand(ctx,w,h,bounds) { ctx.fillStyle="rgba(31,69,56,.45)"; ctx.fillRect(0,0,w,h); ctx.fillStyle="rgba(83,125,89,.12)"; for(let i=0;i<18;i++){const x=(i*173)%w,y=(i*97)%h;ctx.beginPath();ctx.arc(x,y,7+(i%4)*3,0,Math.PI*2);ctx.fill();} }
  function pathPolygon(ctx,points) { ctx.beginPath(); points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath(); }
  function drawWater(ctx,points,tilted) { pathPolygon(ctx,points); const g=ctx.createLinearGradient(0,0,0,ctx.canvas.height); g.addColorStop(0, tilted ? "rgba(109,187,204,.58)" : "rgba(72,153,171,.62)");g.addColorStop(1,"rgba(17,68,91,.78)");ctx.fillStyle=g;ctx.fill();ctx.strokeStyle="rgba(159,231,199,.78)";ctx.lineWidth=2;ctx.stroke(); if(tilted){ctx.save();ctx.globalAlpha=.15;ctx.translate(0,12);pathPolygon(ctx,points);ctx.fillStyle="#001318";ctx.fill();ctx.restore();} }
  function drawDepthBands(ctx,points) { const w=ctx.canvas.clientWidth||ctx.canvas.width, h=ctx.canvas.clientHeight||ctx.canvas.height; const center=points.reduce((a,p)=>({x:a.x+p.x/points.length,y:a.y+p.y/points.length}),{x:0,y:0}); const max=Math.max(...lake().contourLevels); lake().contourLevels.slice().reverse().forEach((level,i)=>{const f=.18 + .68*(level/max); const ring=points.map((p)=>({x:center.x+(p.x-center.x)*f,y:center.y+(p.y-center.y)*f})); pathPolygon(ctx,ring);ctx.fillStyle=`rgba(${28+i*8},${95+i*12},${130+i*10},${.06+i*.012})`;ctx.fill();ctx.strokeStyle=`rgba(159,231,199,${.10+i*.012})`;ctx.lineWidth=1;ctx.stroke(); }); ctx.save();ctx.font=Math.max(10,w/105).toFixed(0)+"px -apple-system, sans-serif";ctx.fillStyle="rgba(236,248,244,.72)";ctx.textAlign="center"; lake().contourLevels.forEach((level,i)=>{const a=-.8+i/(lake().contourLevels.length-1)*2.1; const rx=center.x+Math.cos(a)*Math.min(w*.22,points.reduce((m,p)=>Math.max(m,Math.abs(p.x-center.x)),0))*(.32+i*.07); const ry=center.y+Math.sin(a)*Math.min(h*.22,points.reduce((m,p)=>Math.max(m,Math.abs(p.y-center.y)),0))*(.32+i*.07);ctx.fillText(level+" м",rx,ry);});ctx.restore(); }
  function drawTerrainGrid(ctx,w,h,points) { ctx.save();ctx.globalAlpha=.2;ctx.strokeStyle="#b4eddb";ctx.lineWidth=1;const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y)); for(let i=0;i<7;i++){const y=minY+(maxY-minY)*i/6;ctx.beginPath();ctx.moveTo(minX,y);ctx.lineTo(maxX,y-30);ctx.stroke();} for(let i=0;i<9;i++){const x=minX+(maxX-minX)*i/8;ctx.beginPath();ctx.moveTo(x,minY);ctx.lineTo(x-25,maxY);ctx.stroke();}ctx.restore(); }
  function drawRiver(ctx,bounds) { const w=ctx.canvas.clientWidth||ctx.canvas.width, h=ctx.canvas.clientHeight||ctx.canvas.height; const path=window.BURNAYA_PATH.map((p)=>projectPoint(p[0],p[1],w,h,bounds,34)); ctx.save();ctx.strokeStyle="#f3d889";ctx.globalAlpha=.8;ctx.lineWidth=3;ctx.setLineDash([7,5]);ctx.beginPath();path.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();ctx.setLineDash([]);ctx.fillStyle="#f3d889";ctx.font="11px -apple-system, sans-serif";const mid=path[Math.floor(path.length/2)];ctx.fillText("р. Бурная · проверьте правила",mid.x+8,mid.y-8);ctx.restore(); }
  function drawHotspots(ctx,bounds) { const w=ctx.canvas.clientWidth||ctx.canvas.width, h=ctx.canvas.clientHeight||ctx.canvas.height; ctx.save(); lake().hotspots.forEach((spot,i)=>{const p=projectPoint(spot.lat,spot.lon,w,h,bounds,34);const r=Math.max(16,w/48);const score=scoreAt(new Date(),settings.fish,spot);ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fillStyle="rgba(243,216,137,.15)";ctx.fill();ctx.strokeStyle="rgba(243,216,137,.65)";ctx.setLineDash([3,3]);ctx.lineWidth=1.3;ctx.stroke();ctx.setLineDash([]);ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fillStyle="#f3d889";ctx.fill(); if(i===0 || w>650){ctx.font="11px -apple-system, sans-serif";ctx.fillStyle="rgba(236,248,244,.9)";ctx.textAlign="left";ctx.fillText(spot.name+" · "+score,p.x+r+4,p.y+4);}});ctx.restore(); }
  function drawUser(ctx,p) { ctx.save();ctx.beginPath();ctx.arc(p.x,p.y,10,0,Math.PI*2);ctx.fillStyle="#65cfe0";ctx.fill();ctx.strokeStyle="#e9ffff";ctx.lineWidth=2;ctx.stroke();ctx.beginPath();ctx.arc(p.x,p.y,18,0,Math.PI*2);ctx.strokeStyle="rgba(101,207,224,.45)";ctx.lineWidth=2;ctx.stroke();ctx.restore(); }
  function drawJournalPoints(ctx,w,h,bounds) { const entries=journal.filter((entry)=>entry.lake===selectedLake); if(!entries.length)return; ctx.save(); entries.forEach((entry)=>{const p=projectPoint(entry.lat,entry.lon,w,h,bounds,34);ctx.beginPath();ctx.arc(p.x,p.y,5,0,Math.PI*2);ctx.fillStyle=entry.type==="catch"?"#f17973":"#65cfe0";ctx.fill();ctx.strokeStyle="#07181d";ctx.lineWidth=2;ctx.stroke();}); ctx.restore(); }
  function estimateDepth(lat,lon) { const c=lake().focus || lake().center; const dx=(lon-c[1])*111320*Math.cos(c[0]*Math.PI/180),dy=(lat-c[0])*111320; const d=Math.sqrt(dx*dx+dy*dy); const max=lake().maxDepth; return clamp(max*(.18+.82*(1-Math.min(1,d/1200))), .7, max); }
  let drag = null;
  function mapPointerDown(event) { const canvas=event.currentTarget; drag={x:event.clientX,y:event.clientY,moved:false}; canvas.setPointerCapture?.(event.pointerId); }
  function mapPointerMove(event) { if(!drag)return; const dx=event.clientX-drag.x,dy=event.clientY-drag.y; if(Math.abs(dx)+Math.abs(dy)>5)drag.moved=true; if(drag.moved){mapState.panX+=dx;mapState.panY+=dy;drag.x=event.clientX;drag.y=event.clientY;drawMap();} }
  function mapPointerUp(event) { if(!drag)return; const moved=drag.moved; drag=null; if(!moved){const rect=event.currentTarget.getBoundingClientRect(); const bounds=mapBounds(); const x=event.clientX-rect.left, y=event.clientY-rect.top; const p=unprojectPoint(x,y,rect.width,rect.height,bounds,34); const hotspot=nearestHotspot(p.lat,p.lon,rect.width,rect.height,bounds); if (hotspot) showMapToast(hotspot.name + " · " + hotspot.depth + " · " + hotspot.species + " · шанс " + scoreAt(new Date(), settings.fish, hotspot)); else if (pointInPolygon([p.lat,p.lon], lake().geometry)) openPointModal(p); else showMapToast("Точка вне контура воды — приблизьте карту к берегу");} }
  function unprojectPoint(x,y,w,h,bounds,pad=24) { const cx=w/2,cy=h/2; const rawX=(x-cx-mapState.panX*(w/900))/mapState.scale+cx; const rawY=(y-cy-mapState.panY*(h/560))/mapState.scale+cy; return { lon: bounds.minLon + clamp((rawX-pad)/(w-pad*2),0,1)*(bounds.maxLon-bounds.minLon), lat: bounds.minLat + clamp((h-pad-rawY)/(h-pad*2),0,1)*(bounds.maxLat-bounds.minLat) }; }
  function pointInPolygon(point, polygon) { const lat=point[0],lon=point[1]; let inside=false; for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const yi=polygon[i][0],xi=polygon[i][1],yj=polygon[j][0],xj=polygon[j][1]; const intersect=((xi>lon)!=(xj>lon)) && (lat < (yj-yi)*(lon-xi)/(xj-xi || 1e-12)+yi); if(intersect) inside=!inside;} return inside; }
  function nearestHotspot(lat,lon,w,h,bounds) { let best=null,bestPx=Infinity; lake().hotspots.forEach((spot)=>{const p=projectPoint(spot.lat,spot.lon,w,h,bounds,34); const q=projectPoint(lat,lon,w,h,bounds,34); const d=Math.hypot(p.x-q.x,p.y-q.y); if(d<bestPx){bestPx=d;best=spot;}}); return bestPx<Math.max(24,w*.07) ? best : null; }
  let mapToastTimer=null;
  function showMapToast(message) { const el=$("mapToast"); el.textContent=message; el.hidden=false; clearTimeout(mapToastTimer); mapToastTimer=setTimeout(()=>{el.hidden=true;},3600); }
  function locateUser() { if(!navigator.geolocation){showToast("Геолокация не поддерживается");return;} showToast("Запрашиваю местоположение…",1800);navigator.geolocation.getCurrentPosition((pos)=>{mapState.user={lat:pos.coords.latitude,lon:pos.coords.longitude};drawMap();showToast("Синяя точка — ваше местоположение",2200);},()=>showToast("Разрешите геолокацию в настройках Safari"),{enableHighAccuracy:true,timeout:8000}); }

  function registerServiceWorker() { if("serviceWorker" in navigator){navigator.serviceWorker.register("sw.js").catch(()=>{});} }
  function boot() { setupNavigation(); $("fishSelect").value=settings.fish; navigate(location.hash.slice(1)||"map",false); setConnection(isOnline()?"online":"offline",isOnline()?"онлайн":"локально"); renderSources(); renderAll(); fetchWeather(false); registerServiceWorker(); }
  document.addEventListener("DOMContentLoaded", boot);
})();
