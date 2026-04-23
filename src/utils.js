export const KMH_TO_MPH = 0.621371;

export function weatherCodeToInfo(code) {
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

export function weatherScore(code) {
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

export function formatHour(h) {
  if (h === 0 || h === 24) return '12am';
  if (h < 12) return h + 'am';
  if (h === 12) return '12pm';
  return (h - 12) + 'pm';
}

export function getDayName(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short' });
}

export function seededRandom(seed) {
  let s = Math.abs(seed) || 1;
  return function () {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function getSunTimes(dateStr, lat) {
  const date = new Date(dateStr + 'T12:00:00');
  const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
  const latRad = lat * Math.PI / 180;
  const decl = -23.45 * Math.PI / 180 * Math.cos(2 * Math.PI / 365 * (dayOfYear + 10));
  const cosHa = -Math.tan(latRad) * Math.tan(decl);
  if (cosHa >= 1) return { sunrise: 12, sunset: 12 };
  if (cosHa <= -1) return { sunrise: 0, sunset: 24 };
  const ha = Math.acos(cosHa) * 180 / Math.PI / 15;
  return { sunrise: 12 - ha, sunset: 12 + ha };
}

export function getDayHourRange(dateStr, lat) {
  const st = getSunTimes(dateStr, lat);
  return {
    start: Math.max(0, Math.floor(st.sunrise) - 1),
    end: Math.min(23, Math.ceil(st.sunset) + 1),
  };
}

export function darknessAlpha(hour, sunTimes) {
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

export function computeBestWindow(hours, seaMin, seaMax, sunTimes, beachProfile = {}) {
  if (!hours || hours.length < 2) return null;
  const seaRange = seaMax - seaMin || 1;
  const { minSand = 0, maxSand = 1 } = beachProfile;
  const scores = hours.map(h => {
    if (sunTimes && darknessAlpha(h.hour, sunTimes) >= 0.8) return 0;
    const tideFraction = (h.seaLevel - seaMin) / seaRange;
    const sand = minSand + (maxSand - minSand) * (1 - tideFraction);
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
      const sum = windowScores.reduce((a, b) => a + b, 0);
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

export function computeSeaFrettPct(temp, dewPoint, windDirDeg, windKmh, sst, hour, month) {
  if (dewPoint === null || dewPoint === undefined) return 0;
  let score = 0;

  // Temperature-dew point depression — most critical indicator (max 40 pts)
  const tdd = temp - dewPoint;
  if (tdd <= 2) score += 40;
  else if (tdd <= 4) score += 20;

  // SST ≤ dew point means sea is cold enough to trigger condensation (max 30 pts)
  if (sst !== null && sst !== undefined) {
    const sstDiff = sst - dewPoint;
    if (sstDiff <= 0) score += 30;
    else if (sstDiff <= 2) score += 15;
  }

  // Easterly/onshore wind required for haar advection (max 20 pts)
  if (windDirDeg !== null && windDirDeg !== undefined) {
    if (windDirDeg >= 45 && windDirDeg <= 180) score += 20;      // NE–S: ideal
    else if (windDirDeg > 315 || windDirDeg < 45) score += 8;   // N–NE: marginal
  }

  // Moderate wind speed — enough to advect fog, not so strong it mixes out (max 10 pts)
  const windMph = windKmh * KMH_TO_MPH;
  if (windMph >= 5 && windMph <= 25) score += 10;
  else if (windMph > 25 && windMph <= 35) score += 5;

  // Seasonal multiplier: Apr–Jun peak season along UK east coast
  let seasonMult;
  if (month >= 4 && month <= 6) seasonMult = 1.3;
  else if (month >= 7 && month <= 9) seasonMult = 1.0;
  else seasonMult = 0.5;

  // Time-of-day multiplier: sea frett most common in the morning
  let timeMult;
  if (hour >= 5 && hour <= 9) timeMult = 1.2;
  else if (hour >= 10 && hour <= 14) timeMult = 1.0;
  else if (hour >= 15 && hour <= 20) timeMult = 0.7;
  else timeMult = 0.6;

  return Math.min(100, Math.round(score * seasonMult * timeMult));
}

export function extractDayData(data, dayIdx, lat) {
  const w = data.weather.hourly;
  const m = data.marine.hourly;
  const dates = [...new Set(w.time.map(t => t.split('T')[0]))];
  const targetDate = dates[dayIdx];
  if (!targetDate) return null;
  const { start: HOURS_START, end: HOURS_END } = getDayHourRange(targetDate, lat);
  const month = parseInt(targetDate.split('-')[1], 10);
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
    const temp = w.temperature_2m[wi];
    const dewPoint = w.dew_point_2m ? (w.dew_point_2m[wi] ?? null) : null;
    const windDir = w.wind_direction_10m ? (w.wind_direction_10m[wi] ?? null) : null;
    const sst = mi !== -1 ? (m.sea_surface_temperature ? (m.sea_surface_temperature[mi] ?? null) : null) : null;
    hours.push({
      hour: h,
      temp,
      dewPoint,
      weatherCode: w.weather_code[wi],
      windKmh,
      windDir,
      windMph,
      gustMph,
      showGust,
      precip: w.precipitation[wi] || 0,
      seaLevel: mi !== -1 ? (m.sea_level_height_msl[mi] ?? 0) : 0,
      waveHeight: mi !== -1 ? (m.wave_height[mi] ?? 0) : 0,
      seaSurfaceTemp: sst,
      seaFrettPct: computeSeaFrettPct(temp, dewPoint, windDir, windKmh, sst, h, month),
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
