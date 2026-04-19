import './main.css';
import BATHING_WATERS from '../data/bathing-waters.json';

(function () {
  'use strict';

  const KMH_TO_MPH = 0.621371;

  // ── Location state ────────────────────────────────────────────────────────
  const DEFAULT_LOCATION = { name: 'Whitley Bay', lat: 55.0464, lon: -1.4444, type: 'Coastal' };
  const LS_KEY = 'beachWalkLocation';

  function loadSavedLocation() {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) { /* ignore */ }
    return DEFAULT_LOCATION;
  }

  function saveLocation(loc) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(loc)); } catch (e) { /* ignore */ }
  }

  let currentLocation = loadSavedLocation();

  function getLat() { return currentLocation.lat; }
  function getLon() { return currentLocation.lon; }

  function applyLocationUI() {
    const name = currentLocation.name;
    const btnEl = document.getElementById('locationBtnName');
    if (btnEl) btnEl.textContent = name;
    const footerEl = document.getElementById('footerLocation');
    if (footerEl) footerEl.textContent = name;
  }

  // ── Location list ────────────────────────────────────────────────────────
  let bathingWaters = BATHING_WATERS;
  let allLocationsFiltered = [];

  // ── Location picker modal ────────────────────────────────────────────────
  let vpResizeHandler = null;

  function syncSheetToViewport() {
    if (!window.visualViewport) return;
    const overlay = document.getElementById('locOverlay');
    const sheet = overlay.querySelector('.loc-sheet');
    const vvHeight = window.visualViewport.height;
    if (window.innerWidth <= 640) {
      // Mobile: sheet is top-anchored; shrink from bottom as keyboard appears
      overlay.style.paddingBottom = '';
      sheet.style.maxHeight = Math.max(100, vvHeight - 68) + 'px';
    } else {
      // Desktop: push sheet up above keyboard with paddingBottom
      const keyboardHeight = window.innerHeight - window.visualViewport.offsetTop - vvHeight;
      overlay.style.paddingBottom = Math.max(0, keyboardHeight) + 'px';
      sheet.style.maxHeight = Math.floor(vvHeight * 0.9) + 'px';
    }
  }

  window.openLocationPicker = function () {
    document.getElementById('locOverlay').classList.add('open');
    document.getElementById('locSearch').value = '';
    allLocationsFiltered = bathingWaters;
    renderLocList(bathingWaters);
    if (window.visualViewport) {
      syncSheetToViewport();
      vpResizeHandler = syncSheetToViewport;
      window.visualViewport.addEventListener('resize', vpResizeHandler);
    }
    setTimeout(() => document.getElementById('locSearch').focus(), 50);
  };

  window.closeLocationPicker = function () {
    document.getElementById('locOverlay').classList.remove('open');
    if (window.visualViewport && vpResizeHandler) {
      window.visualViewport.removeEventListener('resize', vpResizeHandler);
      vpResizeHandler = null;
    }
    const overlay = document.getElementById('locOverlay');
    overlay.style.paddingBottom = '';
    overlay.querySelector('.loc-sheet').style.maxHeight = '';
  };

  window.handleOverlayClick = function (e) {
    if (e.target === document.getElementById('locOverlay')) closeLocationPicker();
  };

  window.filterLocations = function (query) {
    if (!bathingWaters) return;
    const q = query.trim().toLowerCase();
    const filtered = q ? bathingWaters.filter(l => l.name.toLowerCase().includes(q)) : bathingWaters;
    allLocationsFiltered = filtered;
    renderLocList(filtered);
  };

  function renderLocList(locs) {
    const el = document.getElementById('locList');
    if (!locs) { el.innerHTML = '<div class="loc-loading">Loading beaches…</div>'; return; }
    if (!locs.length) { el.innerHTML = '<div class="loc-empty">No beaches found</div>'; return; }
    el.innerHTML = locs.map(l => {
      const isActive = l.name === currentLocation.name && Math.abs(l.lat - currentLocation.lat) < 0.001;
      return `<div class="loc-item${isActive ? ' active' : ''}" onclick="selectLocation(${JSON.stringify(l).replace(/"/g, '&quot;')})">
        <div>
          <div class="loc-item-name">${l.name}</div>
          <div class="loc-item-type">${l.type} bathing water</div>
        </div>
        <span class="loc-item-tick">✓</span>
      </div>`;
    }).join('');
    const active = el.querySelector('.loc-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  window.selectLocation = async function (loc) {
    currentLocation = loc;
    saveLocation(loc);
    applyLocationUI();
    closeLocationPicker();
    memCache = null;
    selectedDayIndex = 0;
    document.getElementById('mainContent').style.display = '';
    document.getElementById('errorState').classList.remove('visible');
    document.getElementById('loadingOverlay').classList.remove('hidden');
    try {
      showSkeleton();
      const data = await fetchAllData();
      allData = data;
      document.getElementById('loadingOverlay').classList.add('hidden');
      renderDayTabs(data);
      renderDay(data, true);
    } catch (err) {
      document.getElementById('loadingOverlay').classList.add('hidden');
      document.getElementById('errorState').classList.add('visible');
      document.getElementById('mainContent').style.display = 'none';
    }
  };

  // ── Sun times ────────────────────────────────────────────────────────────
  /**
   * Returns the dynamic hour range for a given day based on sunrise/sunset.
   * Range is (sunrise - 1h) to (sunset + 1h), clamped to 0–23.
   */
  function getDayHourRange(dateStr) {
    const st = getSunTimes(dateStr);
    return {
      start: Math.max(0, Math.floor(st.sunrise) - 1),
      end: Math.min(23, Math.ceil(st.sunset) + 1),
    };
  }

  /**
   * Approximates sunrise/sunset for the current location's latitude.
   * Returns { sunrise, sunset } as decimal hours in local time.
   */
  function getSunTimes(dateStr) {
    const date = new Date(dateStr + 'T12:00:00');
    const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
    const latRad = getLat() * Math.PI / 180;
    const decl = -23.45 * Math.PI / 180 * Math.cos(2 * Math.PI / 365 * (dayOfYear + 10));
    const cosHa = -Math.tan(latRad) * Math.tan(decl);
    if (cosHa >= 1) return { sunrise: 12, sunset: 12 }; // polar night
    if (cosHa <= -1) return { sunrise: 0, sunset: 24 }; // midnight sun
    const ha = Math.acos(cosHa) * 180 / Math.PI / 15;
    return { sunrise: 12 - ha, sunset: 12 + ha };
  }

  /**
   * Returns a darkness alpha value [0..1] for a given hour relative to sunrise/sunset.
   * 0 = full daylight, 0.88 = full dark. Fades over 1.5h around dawn/dusk.
   */
  function darknessAlpha(hour, sunTimes) {
    const { sunrise, sunset } = sunTimes;
    const fadeDur = 1.5;
    const maxDark = 0.88;
    if (hour <= sunrise - fadeDur || hour >= sunset + fadeDur) return maxDark;
    if (hour >= sunrise + fadeDur && hour <= sunset - fadeDur) return 0;
    if (hour < sunrise + fadeDur) {
      const t = (hour - (sunrise - fadeDur)) / (2 * fadeDur);
      return maxDark * (1 - Math.max(0, Math.min(1, t)));
    }
    const t = (hour - (sunset - fadeDur)) / (2 * fadeDur);
    return maxDark * Math.max(0, Math.min(1, t));
  }

  // ── App state ─────────────────────────────────────────────────────────────
  let allData = null;
  let selectedDayIndex = 0;
  let animFrame = null;
  let memCache = null;

  // ── Weather helpers ───────────────────────────────────────────────────────
  function weatherCodeToInfo(code) {
    if (code === 0) return { icon: '☀️', desc: 'Clear sky', cat: 'clear' };
    if (code === 1) return { icon: '🌤️', desc: 'Mainly clear', cat: 'clear' };
    if (code === 2) return { icon: '⛅', desc: 'Partly cloudy', cat: 'partial' };
    if (code === 3) return { icon: '☁️', desc: 'Overcast', cat: 'cloud' };
    if (code >= 45 && code <= 48) return { icon: '🌫️', desc: 'Foggy', cat: 'fog' };
    if (code >= 51 && code <= 55) return { icon: '🌦️', desc: 'Drizzle', cat: 'rain' };
    if (code >= 56 && code <= 57) return { icon: '🌧️', desc: 'Freezing drizzle', cat: 'rain' };
    if (code >= 61 && code <= 63) return { icon: '🌧️', desc: 'Rain', cat: 'rain' };
    if (code >= 65 && code <= 67) return { icon: '🌧️', desc: 'Heavy rain', cat: 'rain' };
    if (code >= 71 && code <= 77) return { icon: '❄️', desc: 'Snow', cat: 'snow' };
    if (code >= 80 && code <= 81) return { icon: '🌦️', desc: 'Showers', cat: 'rain' };
    if (code === 82) return { icon: '⛈️', desc: 'Heavy showers', cat: 'rain' };
    if (code >= 85 && code <= 86) return { icon: '❄️', desc: 'Snow showers', cat: 'snow' };
    if (code >= 95) return { icon: '⛈️', desc: 'Thunderstorm', cat: 'storm' };
    return { icon: '☁️', desc: 'Cloudy', cat: 'cloud' };
  }

  /**
   * Returns a [0..1] score for how beach-walk-friendly a weather code is.
   */
  function weatherScore(code) {
    if (code <= 1) return 1.0;
    if (code === 2) return 0.8;
    if (code === 3) return 0.55;
    if (code >= 45 && code <= 48) return 0.35;
    if (code >= 51 && code <= 55) return 0.25;
    if (code >= 61 && code <= 65) return 0.15;
    if (code >= 80 && code <= 82) return 0.15;
    if (code >= 95) return 0.05;
    if (code >= 71) return 0.1;
    return 0.4;
  }

  function formatHour(h) {
    if (h === 0 || h === 24) return '12am';
    if (h < 12) return h + 'am';
    if (h === 12) return '12pm';
    return (h - 12) + 'pm';
  }

  function getDayName(dateStr) {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
  }

  function seededRandom(seed) {
    let s = Math.abs(seed) || 1;
    return function () {
      s = (s * 16807 + 0) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  function setRefreshing(active) {
    const icon = document.getElementById('updatedIcon');
    if (icon) icon.classList.toggle('spinning', active);
  }

  // ── API ───────────────────────────────────────────────────────────────────
  /**
   * Fetches weather and marine data from Open-Meteo APIs.
   * Caches in memory for 30 minutes; pass force=true to bypass.
   *
   * APIs used:
   *   - https://api.open-meteo.com/v1/forecast  (weather)
   *   - https://marine-api.open-meteo.com/v1/marine  (tide / sea temp / wave height)
   */
  async function fetchAllData(force) {
    if (!force && memCache && Date.now() - memCache.ts < 30 * 60 * 1000) return memCache;
    const lat = getLat(), lon = getLon();
    const [wRes, mRes] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,precipitation&timezone=Europe/London&forecast_days=4`),
      fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&hourly=sea_level_height_msl,wave_height,sea_surface_temperature&timezone=Europe/London&forecast_days=4`),
    ]);
    if (!wRes.ok || !mRes.ok) throw new Error('API error');
    const weather = await wRes.json();
    const marine = await mRes.json();
    const data = { weather, marine, ts: Date.now() };
    memCache = data;
    const d = new Date(data.ts);
    const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const tsEl = document.getElementById('updatedTs');
    if (tsEl) tsEl.textContent = timeStr;
    const timeContainer = document.getElementById('updatedTime');
    if (timeContainer) timeContainer.title = 'Updated ' + timeStr;
    return data;
  }

  // ── Data processing ───────────────────────────────────────────────────────
  function extractDayData(data, dayIdx) {
    const w = data.weather.hourly;
    const m = data.marine.hourly;
    const dates = [...new Set(w.time.map(t => t.split('T')[0]))];
    const targetDate = dates[dayIdx];
    if (!targetDate) return null;
    const { start: HOURS_START, end: HOURS_END } = getDayHourRange(targetDate);
    const hours = [];
    for (let h = HOURS_START; h <= HOURS_END; h++) {
      const ts = targetDate + 'T' + String(h).padStart(2, '0') + ':00';
      const wi = w.time.indexOf(ts);
      const mi = m.time.indexOf(ts);
      if (wi === -1) continue;
      const windKmh = w.wind_speed_10m[wi];
      const gustKmh = w.wind_gusts_10m ? (w.wind_gusts_10m[wi] || windKmh) : windKmh;
      const windMph = Math.round(windKmh * KMH_TO_MPH);
      const gustMph = Math.round(gustKmh * KMH_TO_MPH);
      const showGust = gustMph >= 25 && gustMph > windMph + 8;
      hours.push({
        hour: h,
        temp: w.temperature_2m[wi],
        weatherCode: w.weather_code[wi],
        windKmh,
        windMph,
        gustMph,
        showGust,
        precip: w.precipitation[wi] || 0,
        seaLevel: mi !== -1 ? (m.sea_level_height_msl[mi] ?? 0) : 0,
        waveHeight: mi !== -1 ? (m.wave_height[mi] ?? 0) : 0,
        seaSurfaceTemp: mi !== -1 ? (m.sea_surface_temperature ? (m.sea_surface_temperature[mi] ?? null) : null) : null,
      });
    }
    const allSea = m.sea_level_height_msl.filter(v => v != null);
    const sstVals = hours.map(h => h.seaSurfaceTemp).filter(v => v != null);
    const avgSST = sstVals.length ? (sstVals.reduce((a, b) => a + b, 0) / sstVals.length) : null;
    return {
      hours,
      date: targetDate,
      seaMin: Math.min(...allSea),
      seaMax: Math.max(...allSea),
      dates,
      hoursStart: HOURS_START,
      hoursEnd: HOURS_END,
      avgSST,
    };
  }

  // ── Best window algorithm ─────────────────────────────────────────────────
  /**
   * Scores each hour and finds the best 2–3 hour window for a beach walk.
   *
   * Scoring weights:
   *   - Sand exposure (low tide):  30%
   *   - Weather:                   25%
   *   - Wind:                      25%
   *   - Temperature:               20%
   *
   * Dark hours are excluded (score = 0).
   */
  function computeBestWindow(hours, seaMin, seaMax, sunTimes) {
    if (!hours || hours.length < 2) return null;
    const seaRange = seaMax - seaMin || 1;
    const scores = hours.map(h => {
      if (sunTimes && darknessAlpha(h.hour, sunTimes) >= 0.8) return 0;
      const sand = 1 - ((h.seaLevel - seaMin) / seaRange);
      const wx = weatherScore(h.weatherCode);
      const wind = Math.max(0, 1 - (h.windMph / 35));
      const temp = Math.max(0, 1 - Math.abs(h.temp - 18) / 20);
      return sand * 0.30 + wx * 0.25 + wind * 0.25 + temp * 0.20;
    });
    let bestScore = -1, bestStart = 0, bestLen = 2;
    for (let len = 2; len <= 3; len++) {
      for (let i = 0; i <= scores.length - len; i++) {
        const windowScores = scores.slice(i, i + len);
        if (windowScores.some(s => s === 0)) continue;
        let sum = windowScores.reduce((a, b) => a + b, 0);
        const adj = (sum / len) * (len === 3 ? 1.03 : 1.0);
        if (adj > bestScore) { bestScore = adj; bestStart = i; bestLen = len; }
      }
    }
    if (bestScore < 0) return null;
    return {
      startIdx: bestStart,
      endIdx: bestStart + bestLen - 1,
      startHour: hours[bestStart].hour,
      endHour: hours[bestStart + bestLen - 1].hour,
      scores,
    };
  }

  // ── Render: day tabs ──────────────────────────────────────────────────────
  function renderDayTabs(data) {
    const el = document.getElementById('dayTabs');
    const dates = [...new Set(data.weather.hourly.time.map(t => t.split('T')[0]))];
    const today = new Date().toISOString().split('T')[0];
    el.innerHTML = '';
    dates.forEach((date, i) => {
      const btn = document.createElement('button');
      btn.className = 'day-tab' + (i === selectedDayIndex ? ' active' : '');
      btn.textContent = date === today ? 'Today' : (i === 1 && dates[0] === today) ? 'Tomorrow' : getDayName(date);
      btn.addEventListener('click', () => { selectedDayIndex = i; renderDayTabs(data); renderDay(data, false); });
      el.appendChild(btn);
    });
  }

  // ── Render: current conditions ────────────────────────────────────────────
  function renderCurrentConditions(data) {
    const el = document.getElementById('currentConditions');
    const todayData = extractDayData(data, 0);
    if (!todayData || !todayData.hours.length) { el.innerHTML = ''; return; }
    const now = new Date();
    const h = todayData.hours.find(x => x.hour === now.getHours()) || todayData.hours[0];
    const info = weatherCodeToInfo(h.weatherCode);
    el.innerHTML = `
      <div class="condition-item">${info.icon} <span class="condition-value">${info.desc}</span></div>
      <div class="condition-item">🌡️ <span class="condition-value">${Math.round(h.temp)}°C</span></div>
      <div class="condition-item">💨 <span class="condition-value">${h.windMph} mph</span></div>
      ${h.showGust ? `<div class="condition-item">⚠️ <span class="condition-value" style="color:#F39C12">Gusts ${h.gustMph} mph</span></div>` : ''}
    `;
  }

  // ── Render: weather strip ─────────────────────────────────────────────────
  function renderWeatherStrip(dayData, best) {
    const colCount = dayData.hours.length;
    document.documentElement.style.setProperty('--col-count', colCount);
    const el = document.getElementById('weatherStrip');
    el.className = 'weather-strip';
    if (!dayData || !dayData.hours.length) {
      el.innerHTML = '<div style="padding:20px;text-align:center;color:#7A7974;grid-column:1/-1">No data available</div>';
      return;
    }
    const nowHour = new Date().getHours();
    el.innerHTML = dayData.hours.map((h, i) => {
      const info = weatherCodeToInfo(h.weatherCode);
      const isBest = best && i >= best.startIdx && i <= best.endIdx;
      const isCurrent = selectedDayIndex === 0 && h.hour === nowHour;
      const precipHtml = h.precip > 0.1
        ? `<div class="weather-precip">${h.precip.toFixed(1)}mm</div>`
        : `<div class="weather-precip-empty"></div>`;
      const gustHtml = h.showGust
        ? `<div class="weather-gust">Gusts:${h.gustMph}</div>`
        : `<div class="weather-gust-empty"></div>`;
      return `<div class="weather-col${isBest ? ' best-hour' : ''}${isCurrent ? ' current-hour' : ''}">
        <div class="weather-temp">${Math.round(h.temp)}°</div>
        <div class="weather-wind">${h.windMph}<small>mph</small></div>
        ${gustHtml}
        <div class="weather-icon">${info.icon}</div>
        ${precipHtml}
        <div class="weather-hour">${formatHour(h.hour)}</div>
      </div>`;
    }).join('');
  }

  // ── Render: best time banner ──────────────────────────────────────────────
  window.openBestTimeInfo = function (e) {
    e.stopPropagation();
    document.getElementById('bestTimePopover').classList.add('open');
    document.getElementById('bestTimeOverlay').style.display = 'block';
  };
  window.closeBestTimeInfo = function () {
    document.getElementById('bestTimePopover').classList.remove('open');
    document.getElementById('bestTimeOverlay').style.display = 'none';
  };

  function renderBestTimeBanner(best) {
    const el = document.getElementById('bestTimeBanner');
    if (!best) { el.classList.remove('visible'); return; }
    el.classList.add('visible');
    el.innerHTML = `<span class="label">🚶 Best time for a walk</span><span class="time-range">${formatHour(best.startHour)} – ${formatHour(best.endHour + 1)}</span><button class="best-time-info-btn" onclick="openBestTimeInfo(event)" aria-label="How is this calculated?">i</button>`;
  }

  // ── Render: beach canvas ──────────────────────────────────────────────────
  /**
   * Draws an animated beach scene on a <canvas> element.
   * Renders:
   *  - Sky gradient
   *  - Sand with texture
   *  - Animated sea surface tied to tidal height data
   *  - Wet sand shadow zone
   *  - Sea foam lines and underwater ripples
   *  - Darkness overlay based on sunrise/sunset
   *  - Sea surface temperature badge
   *  - Current hour indicator line (today only)
   */
  function renderBeachCanvas(dayData) {
    const canvas = document.getElementById('beachCanvas');
    const container = document.getElementById('beachContainer');
    const dpr = window.devicePixelRatio || 1;

    const W = container.clientWidth;
    const headerEl = document.getElementById('header');
    const bannerEl = document.getElementById('bestTimeBanner');
    const stripEl = document.querySelector('.weather-strip-container');
    const aboveH = (headerEl ? headerEl.offsetHeight : 0) +
                   (bannerEl ? bannerEl.offsetHeight : 0) +
                   (stripEl ? stripEl.offsetHeight : 0);
    const H = Math.max(180, Math.min(600, window.innerHeight - aboveH));
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Update floating SST badge (fixed to viewport centre)
    const sstBadge = document.getElementById('sstBadge');
    if (sstBadge) {
      if (dayData && dayData.avgSST != null) {
        const sstTempEl = sstBadge.querySelector('.sst-temp');
        if (sstTempEl) sstTempEl.textContent = Math.round(dayData.avgSST) + '\u00B0C';
        sstBadge.style.bottom = '14px';
        sstBadge.style.display = 'flex';
      } else {
        sstBadge.style.display = 'none';
      }
    }

    if (!dayData || !dayData.hours.length) {
      ctx.fillStyle = '#F5E6D3';
      ctx.fillRect(0, 0, W, H);
      return;
    }

    const hours = dayData.hours;
    const seaMin = dayData.seaMin;
    const seaMax = dayData.seaMax;
    const seaRange = seaMax - seaMin || 1;
    const colW = W / hours.length;

    const SEA_Y_HIGH = H * 0.08;
    const SEA_Y_LOW = H * 0.90;

    const seaYPoints = hours.map(h => {
      const norm = (h.seaLevel - seaMin) / seaRange;
      return SEA_Y_LOW - norm * (SEA_Y_LOW - SEA_Y_HIGH);
    });

    const sunTimes = getSunTimes(dayData.date);
    const dateSeed = parseInt(dayData.date.replace(/-/g, ''));

    function interpolateSeaY(x) {
      const cf = (x / W) * (hours.length - 1);
      const ci = Math.min(Math.floor(cf), hours.length - 2);
      const frac = cf - ci;
      const sf = frac * frac * (3 - 2 * frac);
      return seaYPoints[ci] + (seaYPoints[ci + 1] - seaYPoints[ci]) * sf;
    }

    function buildSeaSurface(t, amp) {
      const waveFreq = 0.016;
      const pts = [];
      for (let x = 0; x <= W; x += 2) {
        const baseY = interpolateSeaY(x);
        const wave = Math.sin(x * waveFreq + t * 1.3) * amp +
          Math.sin(x * waveFreq * 2.1 + t * 0.8 + 2) * (amp * 0.35);
        pts.push({ x, y: baseY + wave });
      }
      return pts;
    }

    function applyPath(pts) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    }

    function drawFrame(time) {
      ctx.clearRect(0, 0, W, H);
      const t = time * 0.001;
      const waveAmp = 4;

      // Sky
      const skyGrad = ctx.createLinearGradient(0, 0, 0, H * 0.3);
      skyGrad.addColorStop(0, '#94c9e2');
      skyGrad.addColorStop(0.6, '#b8d9ea');
      skyGrad.addColorStop(1, '#d4e8f0');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, W, H);

      // Sand base
      const SAND_TOP = H * 0.04;
      const sandGrad = ctx.createLinearGradient(0, SAND_TOP, 0, H);
      sandGrad.addColorStop(0, '#F7E18C');
      sandGrad.addColorStop(0.2, '#EFD06A');
      sandGrad.addColorStop(0.5, '#DDBA42');
      sandGrad.addColorStop(0.8, '#C9A52E');
      sandGrad.addColorStop(1, '#B08F20');
      ctx.fillStyle = sandGrad;
      ctx.fillRect(0, SAND_TOP, W, H - SAND_TOP);

      // Sand texture dots (seeded for consistency)
      const texRng = seededRandom(dateSeed);
      for (let i = 0; i < 280; i++) {
        const tx = texRng() * W;
        const ty = SAND_TOP + texRng() * (H - SAND_TOP);
        const tr = texRng() * 1.6 + 0.3;
        const bright = texRng() > 0.5;
        ctx.fillStyle = bright ? 'rgba(255,240,180,0.10)' : 'rgba(160,120,40,0.07)';
        ctx.beginPath();
        ctx.arc(tx, ty, tr, 0, Math.PI * 2);
        ctx.fill();
      }

      // Sea surface
      const surfacePts = buildSeaSurface(t, waveAmp);

      // Wet sand shadow
      const surfaceByX = new Float32Array(W + 1);
      for (let i = 0; i < surfacePts.length; i++) {
        const sx = Math.round(surfacePts[i].x);
        if (sx >= 0 && sx <= W) surfaceByX[sx] = surfacePts[i].y;
      }
      for (let x = 1; x < surfaceByX.length; x++) {
        if (surfaceByX[x] === 0) surfaceByX[x] = surfaceByX[x - 1];
      }
      const wetBand = 28;
      const wetStep = 2;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, interpolateSeaY(0) - wetBand);
      for (let x = wetStep; x <= W; x += wetStep) {
        ctx.lineTo(x, interpolateSeaY(x) - wetBand);
      }
      for (let x = W; x >= 0; x -= wetStep) {
        const sx = Math.min(W, Math.round(x));
        ctx.lineTo(x, surfaceByX[sx]);
      }
      ctx.closePath();
      const minBaseY = Math.min(...seaYPoints);
      const wetGrad = ctx.createLinearGradient(0, minBaseY - wetBand, 0, minBaseY + 4);
      wetGrad.addColorStop(0, 'rgba(130,105,35,0)');
      wetGrad.addColorStop(1, 'rgba(100,78,22,0.40)');
      ctx.fillStyle = wetGrad;
      ctx.fill();
      ctx.restore();

      // Main sea fill
      ctx.save();
      applyPath(surfacePts);
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      const minSeaY = Math.min(...seaYPoints);
      const seaGrad = ctx.createLinearGradient(0, minSeaY - 10, 0, H);
      seaGrad.addColorStop(0, 'rgba(66,165,220,0.82)');
      seaGrad.addColorStop(0.10, 'rgba(46,134,193,0.90)');
      seaGrad.addColorStop(0.35, 'rgba(26,82,118,0.94)');
      seaGrad.addColorStop(0.70, 'rgba(18,60,90,0.97)');
      seaGrad.addColorStop(1, '#0e2f47');
      ctx.fillStyle = seaGrad;
      ctx.fill();
      ctx.restore();

      // Foam lines
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.lineWidth = 2.5;
      applyPath(surfacePts);
      ctx.stroke();

      const surfacePts2 = buildSeaSurface(t * 1.0 + 1.2, waveAmp * 0.65);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(surfacePts2[0].x, surfacePts2[0].y + 9);
      for (let i = 1; i < surfacePts2.length; i++) ctx.lineTo(surfacePts2[i].x, surfacePts2[i].y + 9);
      ctx.stroke();

      // Underwater ripples
      applyPath(surfacePts);
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.clip();
      for (let wi = 0; wi < 5; wi++) {
        const offY = 18 + wi * 17;
        const ripAmp = waveAmp * 0.4;
        const ripFreq = 0.013;
        ctx.beginPath();
        ctx.strokeStyle = `rgba(255,255,255,${0.09 - wi * 0.015})`;
        ctx.lineWidth = 1;
        for (let x = 0; x <= W; x += 2) {
          const baseY = interpolateSeaY(x);
          const rip = Math.sin(x * ripFreq + t * (0.85 - wi * 0.12) + wi * 2.3) * ripAmp;
          if (x === 0) ctx.moveTo(x, baseY + offY + rip);
          else ctx.lineTo(x, baseY + offY + rip);
        }
        ctx.stroke();
      }
      ctx.restore();

      // Darkness overlay (horizontal gradient, no column banding)
      const darkGrad = ctx.createLinearGradient(0, 0, W, 0);
      darkGrad.addColorStop(0, `rgba(10,20,40,${darknessAlpha(hours[0].hour, sunTimes)})`);
      hours.forEach((h, i) => {
        const stopPos = Math.max(0.001, Math.min(0.999, (i + 0.5) * colW / W));
        darkGrad.addColorStop(stopPos, `rgba(10,20,40,${darknessAlpha(h.hour, sunTimes)})`);
      });
      darkGrad.addColorStop(1, `rgba(10,20,40,${darknessAlpha(hours[hours.length - 1].hour, sunTimes)})`);
      ctx.fillStyle = darkGrad;
      ctx.fillRect(0, 0, W, H);

      // Current hour indicator line (today only)
      if (selectedDayIndex === 0) {
        const nowH = new Date().getHours();
        const nowIdx = hours.findIndex(h => h.hour === nowH);
        if (nowIdx >= 0) {
          const lineX = (nowIdx + 0.5) * colW;
          ctx.save();
          ctx.strokeStyle = 'rgba(52,152,219,0.75)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(lineX, 0);
          ctx.lineTo(lineX, H);
          ctx.stroke();
          ctx.restore();
        }
      }

      animFrame = requestAnimationFrame(drawFrame);
    }

    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = requestAnimationFrame(drawFrame);
  }

  // ── Render: tide axis ─────────────────────────────────────────────────────
  function renderTideAxis(dayData) {
    const axisCanvas = document.getElementById('tideAxis');
    const beachContainer = document.getElementById('beachContainer');
    const beachOuter = document.getElementById('beachOuter');
    if (!axisCanvas || !beachContainer) return;

    const dpr = window.devicePixelRatio || 1;
    const AXIS_W = 38;
    const beachCanvas = document.getElementById('beachCanvas');
    const H = beachCanvas ? beachCanvas.offsetHeight : 300;

    const beachTop = beachContainer.offsetTop;
    axisCanvas.style.top = beachTop + 'px';
    axisCanvas.style.width = AXIS_W + 'px';
    axisCanvas.style.height = H + 'px';
    axisCanvas.width = AXIS_W * dpr;
    axisCanvas.height = H * dpr;

    const ctx = axisCanvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, AXIS_W, H);

    if (!dayData || !dayData.hours.length) return;

    const SEA_Y_HIGH = H * 0.08;
    const SEA_Y_LOW = H * 0.90;
    const seaMin = dayData.seaMin;
    const seaMax = dayData.seaMax;
    const seaRange = seaMax - seaMin || 1;
    const displayRange = seaRange;

    const tickStep = displayRange <= 2 ? 0.5 : 1.0;
    const ticks = [];
    for (let v = 0; v <= displayRange + 0.001; v += tickStep) {
      ticks.push(parseFloat(v.toFixed(2)));
    }

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(15,25,45,0.82)');
    grad.addColorStop(1, 'rgba(15,25,45,0.55)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(0, 0, AXIS_W, H, [0, 6, 6, 0]);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(AXIS_W - 0.5, 0);
    ctx.lineTo(AXIS_W - 0.5, H);
    ctx.stroke();

    ticks.forEach(displayVal => {
      const norm = displayVal / displayRange;
      const y = SEA_Y_LOW - norm * (SEA_Y_LOW - SEA_Y_HIGH);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(AXIS_W - 7, y);
      ctx.lineTo(AXIS_W - 1, y);
      ctx.stroke();
      const label = displayVal % 1 === 0 ? displayVal.toFixed(0) + 'm' : displayVal.toFixed(1) + 'm';
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '600 9px -apple-system, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      if (y > 8 && y < H - 8) {
        ctx.fillText(label, AXIS_W - 9, y);
      }
    });

    ctx.save();
    ctx.translate(8, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.font = '600 7.5px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = '0.06em';
    ctx.fillText('TIDE HEIGHT', 0, 0);
    ctx.restore();
  }

  // ── Render: full day ──────────────────────────────────────────────────────
  function renderDay(data, doScrollToNow) {
    const dayData = extractDayData(data, selectedDayIndex);
    if (!dayData) return;
    const sunTimes = getSunTimes(dayData.date);
    const best = computeBestWindow(dayData.hours, dayData.seaMin, dayData.seaMax, sunTimes);
    renderCurrentConditions(data);
    renderWeatherStrip(dayData, best);
    renderBestTimeBanner(best);
    renderBeachCanvas(dayData);
    requestAnimationFrame(() => renderTideAxis(dayData));

    if (doScrollToNow && selectedDayIndex === 0) {
      const wrapper = document.getElementById('scrollWrapper');
      const now = new Date();
      const currentHour = now.getHours();
      const currentIdx = dayData.hours.findIndex(h => h.hour >= currentHour);
      if (currentIdx >= 0) {
        const colEl = wrapper.querySelector('.weather-col');
        const colW = colEl ? colEl.offsetWidth : 52;
        const viewW = wrapper.offsetWidth;
        const targetScroll = Math.max(0, currentIdx * colW - viewW / 2 + colW / 2);
        wrapper.scrollLeft = targetScroll;
      }
    }
  }

  // ── Skeleton loader ───────────────────────────────────────────────────────
  function showSkeleton() {
    const el = document.getElementById('weatherStrip');
    let html = '';
    const skeletonCount = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--col-count')) || 15;
    for (let i = 0; i < skeletonCount; i++) {
      html += `<div class="skeleton-col">
        <div class="skeleton-block" style="width:24px;height:14px"></div>
        <div class="skeleton-block" style="width:20px;height:20px;border-radius:50%"></div>
        <div class="skeleton-block" style="width:28px;height:10px"></div>
        <div class="skeleton-block" style="width:20px;height:10px"></div>
      </div>`;
    }
    el.innerHTML = html;
    el.className = 'weather-strip skeleton-strip';
  }

  // ── Canvas polyfill ───────────────────────────────────────────────────────
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      if (typeof r === 'number') r = [r, r, r, r];
      this.moveTo(x + r[0], y);
      this.arcTo(x + w, y, x + w, y + h, r[1]);
      this.arcTo(x + w, y + h, x, y + h, r[2]);
      this.arcTo(x, y + h, x, y, r[0]);
      this.arcTo(x, y, x + w, y, r[0]);
    };
  }

  // ── Build time ────────────────────────────────────────────────────────────
  (function setBuildTime() {
    const el = document.getElementById('buildTime');
    if (!el) return;
    try {
      const d = new Date(__BUILD_TIME__);
      el.textContent = 'Built ' + new Intl.DateTimeFormat(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
        timeZoneName: 'short'
      }).format(d);
    } catch (e) {}
  })();

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    applyLocationUI();
    showSkeleton();
    try {
      const data = await fetchAllData();
      allData = data;
      document.getElementById('loadingOverlay').classList.add('hidden');
      renderDayTabs(data);
      renderDay(data, true);
      let rt, lastW = window.innerWidth;
      window.addEventListener('resize', () => {
        const w = window.innerWidth;
        if (w === lastW) return; // ignore height-only changes (mobile browser chrome)
        lastW = w;
        clearTimeout(rt);
        rt = setTimeout(() => renderDay(allData, false), 100);
      });

      // Background refresh every 5 minutes if data is >30 minutes old
      setInterval(async () => {
        if (!memCache || Date.now() - memCache.ts < 30 * 60 * 1000) return;
        try {
          setRefreshing(true);
          const fresh = await fetchAllData(true);
          allData = fresh;
          renderDayTabs(fresh);
          renderDay(fresh, false);
        } catch (e) {
          console.warn('Background refresh failed:', e);
        } finally {
          setRefreshing(false);
        }
      }, 5 * 60 * 1000);

    } catch (err) {
      console.error('Load failed:', err);
      document.getElementById('loadingOverlay').classList.add('hidden');
      document.getElementById('errorState').classList.add('visible');
      document.getElementById('mainContent').style.display = 'none';
    }
  }

  init();
})();
