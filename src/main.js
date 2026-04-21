import './main.css';
import BATHING_WATERS from '../data/bathing-waters.json';
import {
  KMH_TO_MPH,
  weatherCodeToInfo,
  weatherScore,
  formatHour,
  getDayName,
  seededRandom,
  getSunTimes,
  getDayHourRange,
  darknessAlpha,
  computeBestWindow,
  extractDayData,
} from './utils.js';

(function () {
  'use strict';

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

    const type = currentLocation.type;
    const isNonCoastal = type === 'River' || type === 'Lake';
    const notice = document.getElementById('nonCoastalNotice');
    const beachOuter = document.getElementById('beachOuter');
    if (notice) {
      notice.hidden = !isNonCoastal;
      if (isNonCoastal) {
        document.getElementById('nonCoastalIcon').textContent = type === 'River' ? '🏞️' : '🏊';
        document.getElementById('nonCoastalLabel').textContent =
          type === 'River' ? 'River bathing water' : 'Lake bathing water';
      }
    }
    if (beachOuter) beachOuter.style.display = isNonCoastal ? 'none' : '';
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
      // Mobile: fixed height so the search box never moves as results change
      overlay.style.paddingBottom = '';
      const h = Math.max(100, vvHeight - 68) + 'px';
      sheet.style.height = h;
      sheet.style.maxHeight = h;
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
    const sheet = overlay.querySelector('.loc-sheet');
    sheet.style.maxHeight = '';
    sheet.style.height = '';
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

  // ── App state ─────────────────────────────────────────────────────────────
  let allData = null;
  let selectedDayIndex = 0;
  let animFrame = null;
  let memCache = null;

  // ── Weather helpers ───────────────────────────────────────────────────────
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
    const todayData = extractDayData(data, 0, getLat());
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
    const type = currentLocation && currentLocation.type;
    const isNonCoastal = type === 'River' || type === 'Lake';
    if (!best || isNonCoastal) { el.classList.remove('visible'); return; }
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

    const minSand = currentLocation.minSand ?? 0;
    const maxSand = currentLocation.maxSand ?? 1;
    const SEA_Y_HIGH = H * (0.08 + 0.82 * minSand);
    const SEA_Y_LOW = H * (0.08 + 0.82 * maxSand);

    const seaYPoints = hours.map(h => {
      const norm = (h.seaLevel - seaMin) / seaRange;
      return SEA_Y_LOW - norm * (SEA_Y_LOW - SEA_Y_HIGH);
    });

    const sunTimes = getSunTimes(dayData.date, getLat());
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
    const dayData = extractDayData(data, selectedDayIndex, getLat());
    if (!dayData) return;
    const sunTimes = getSunTimes(dayData.date, getLat());
    const best = computeBestWindow(dayData.hours, dayData.seaMin, dayData.seaMax, sunTimes, currentLocation);
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
