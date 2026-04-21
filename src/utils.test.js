import { describe, it, expect } from 'vitest';
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

// ── KMH_TO_MPH ────────────────────────────────────────────────────────────────

describe('KMH_TO_MPH', () => {
  it('has the correct conversion factor', () => {
    expect(KMH_TO_MPH).toBeCloseTo(0.621371);
  });

  it('converts 100 km/h to ~62 mph', () => {
    expect(100 * KMH_TO_MPH).toBeCloseTo(62.1371);
  });
});

// ── weatherCodeToInfo ─────────────────────────────────────────────────────────

describe('weatherCodeToInfo', () => {
  it('returns clear sky for code 0', () => {
    expect(weatherCodeToInfo(0)).toEqual({ icon: '☀️', desc: 'Clear sky', cat: 'clear' });
  });

  it('returns mainly clear for code 1', () => {
    expect(weatherCodeToInfo(1)).toEqual({ icon: '🌤️', desc: 'Mainly clear', cat: 'clear' });
  });

  it('returns partly cloudy for code 2', () => {
    expect(weatherCodeToInfo(2)).toEqual({ icon: '⛅', desc: 'Partly cloudy', cat: 'partial' });
  });

  it('returns overcast for code 3', () => {
    expect(weatherCodeToInfo(3)).toEqual({ icon: '☁️', desc: 'Overcast', cat: 'cloud' });
  });

  it('returns foggy for codes 45–48', () => {
    expect(weatherCodeToInfo(45)).toMatchObject({ desc: 'Foggy', cat: 'fog' });
    expect(weatherCodeToInfo(48)).toMatchObject({ desc: 'Foggy', cat: 'fog' });
  });

  it('returns drizzle for codes 51–55', () => {
    expect(weatherCodeToInfo(51)).toMatchObject({ desc: 'Drizzle', cat: 'rain' });
    expect(weatherCodeToInfo(55)).toMatchObject({ desc: 'Drizzle', cat: 'rain' });
  });

  it('returns freezing drizzle for codes 56–57', () => {
    expect(weatherCodeToInfo(56)).toMatchObject({ desc: 'Freezing drizzle', cat: 'rain' });
    expect(weatherCodeToInfo(57)).toMatchObject({ desc: 'Freezing drizzle', cat: 'rain' });
  });

  it('returns rain for codes 61–63', () => {
    expect(weatherCodeToInfo(61)).toMatchObject({ desc: 'Rain', cat: 'rain' });
    expect(weatherCodeToInfo(63)).toMatchObject({ desc: 'Rain', cat: 'rain' });
  });

  it('returns heavy rain for codes 65–67', () => {
    expect(weatherCodeToInfo(65)).toMatchObject({ desc: 'Heavy rain', cat: 'rain' });
    expect(weatherCodeToInfo(67)).toMatchObject({ desc: 'Heavy rain', cat: 'rain' });
  });

  it('returns snow for codes 71–77', () => {
    expect(weatherCodeToInfo(71)).toMatchObject({ desc: 'Snow', cat: 'snow' });
    expect(weatherCodeToInfo(77)).toMatchObject({ desc: 'Snow', cat: 'snow' });
  });

  it('returns showers for codes 80–81', () => {
    expect(weatherCodeToInfo(80)).toMatchObject({ desc: 'Showers', cat: 'rain' });
    expect(weatherCodeToInfo(81)).toMatchObject({ desc: 'Showers', cat: 'rain' });
  });

  it('returns heavy showers for code 82', () => {
    expect(weatherCodeToInfo(82)).toMatchObject({ desc: 'Heavy showers', cat: 'rain' });
  });

  it('returns snow showers for codes 85–86', () => {
    expect(weatherCodeToInfo(85)).toMatchObject({ desc: 'Snow showers', cat: 'snow' });
    expect(weatherCodeToInfo(86)).toMatchObject({ desc: 'Snow showers', cat: 'snow' });
  });

  it('returns thunderstorm for codes >= 95', () => {
    expect(weatherCodeToInfo(95)).toMatchObject({ desc: 'Thunderstorm', cat: 'storm' });
    expect(weatherCodeToInfo(99)).toMatchObject({ desc: 'Thunderstorm', cat: 'storm' });
  });

  it('returns cloudy as default for unmapped codes', () => {
    expect(weatherCodeToInfo(10)).toMatchObject({ desc: 'Cloudy', cat: 'cloud' });
    expect(weatherCodeToInfo(30)).toMatchObject({ desc: 'Cloudy', cat: 'cloud' });
    expect(weatherCodeToInfo(64)).toMatchObject({ desc: 'Cloudy', cat: 'cloud' });
  });

  it('returns an object with icon, desc and cat properties', () => {
    const result = weatherCodeToInfo(0);
    expect(result).toHaveProperty('icon');
    expect(result).toHaveProperty('desc');
    expect(result).toHaveProperty('cat');
  });
});

// ── weatherScore ──────────────────────────────────────────────────────────────

describe('weatherScore', () => {
  it('returns 1.0 for clear conditions (codes 0 and 1)', () => {
    expect(weatherScore(0)).toBe(1.0);
    expect(weatherScore(1)).toBe(1.0);
  });

  it('returns 0.8 for partly cloudy (code 2)', () => {
    expect(weatherScore(2)).toBe(0.8);
  });

  it('returns 0.55 for overcast (code 3)', () => {
    expect(weatherScore(3)).toBe(0.55);
  });

  it('returns 0.35 for fog (codes 45–48)', () => {
    expect(weatherScore(45)).toBe(0.35);
    expect(weatherScore(48)).toBe(0.35);
  });

  it('returns 0.25 for drizzle (codes 51–55)', () => {
    expect(weatherScore(51)).toBe(0.25);
    expect(weatherScore(55)).toBe(0.25);
  });

  it('returns 0.15 for rain (codes 61–65)', () => {
    expect(weatherScore(61)).toBe(0.15);
    expect(weatherScore(65)).toBe(0.15);
  });

  it('returns 0.15 for showers (codes 80–82)', () => {
    expect(weatherScore(80)).toBe(0.15);
    expect(weatherScore(82)).toBe(0.15);
  });

  it('returns 0.05 for thunderstorm (codes >= 95)', () => {
    expect(weatherScore(95)).toBe(0.05);
    expect(weatherScore(99)).toBe(0.05);
  });

  it('returns 0.1 for snow (codes 71–77)', () => {
    expect(weatherScore(71)).toBe(0.1);
    expect(weatherScore(77)).toBe(0.1);
  });

  it('returns 0.4 as default for unmapped codes', () => {
    expect(weatherScore(10)).toBe(0.4);
    expect(weatherScore(56)).toBe(0.4);
    expect(weatherScore(66)).toBe(0.4);
  });

  it('scores range between 0.0 and 1.0', () => {
    for (const code of [0, 1, 2, 3, 45, 51, 61, 71, 80, 95]) {
      const s = weatherScore(code);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

// ── formatHour ────────────────────────────────────────────────────────────────

describe('formatHour', () => {
  it('formats midnight (0) as 12am', () => {
    expect(formatHour(0)).toBe('12am');
  });

  it('formats hour 24 as 12am', () => {
    expect(formatHour(24)).toBe('12am');
  });

  it('formats AM hours correctly', () => {
    expect(formatHour(1)).toBe('1am');
    expect(formatHour(6)).toBe('6am');
    expect(formatHour(11)).toBe('11am');
  });

  it('formats noon (12) as 12pm', () => {
    expect(formatHour(12)).toBe('12pm');
  });

  it('formats PM hours correctly', () => {
    expect(formatHour(13)).toBe('1pm');
    expect(formatHour(18)).toBe('6pm');
    expect(formatHour(23)).toBe('11pm');
  });
});

// ── getDayName ────────────────────────────────────────────────────────────────

describe('getDayName', () => {
  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  it('returns a valid abbreviated weekday name', () => {
    const name = getDayName('2026-04-19');
    expect(DAYS).toContain(name);
  });

  it('returns the correct day for a known Sunday', () => {
    // 2026-06-21 is a Sunday
    expect(getDayName('2026-06-21')).toBe('Sun');
  });

  it('returns the correct day for a known Monday', () => {
    // 2026-06-22 is a Monday
    expect(getDayName('2026-06-22')).toBe('Mon');
  });

  it('returns consistent results for the same date', () => {
    expect(getDayName('2026-01-01')).toBe(getDayName('2026-01-01'));
  });
});

// ── seededRandom ──────────────────────────────────────────────────────────────

describe('seededRandom', () => {
  it('produces values in [0, 1)', () => {
    const rng = seededRandom(42);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('produces the same sequence for the same seed', () => {
    const rng1 = seededRandom(42);
    const rng2 = seededRandom(42);
    for (let i = 0; i < 20; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('produces different sequences for different seeds', () => {
    const rng1 = seededRandom(42);
    const rng2 = seededRandom(99);
    expect(rng1()).not.toBe(rng2());
  });

  it('treats seed 0 the same as seed 1 (abs(0) || 1)', () => {
    const rng0 = seededRandom(0);
    const rng1 = seededRandom(1);
    expect(rng0()).toBe(rng1());
  });

  it('handles negative seeds via abs()', () => {
    const rngPos = seededRandom(42);
    const rngNeg = seededRandom(-42);
    expect(rngPos()).toBe(rngNeg());
  });

  it('advances state between calls', () => {
    const rng = seededRandom(42);
    const v1 = rng();
    const v2 = rng();
    expect(v1).not.toBe(v2);
  });
});

// ── getSunTimes ───────────────────────────────────────────────────────────────

describe('getSunTimes', () => {
  const LONDON_LAT = 51.5;

  it('returns sunrise before noon and sunset after noon for UK in summer', () => {
    const { sunrise, sunset } = getSunTimes('2026-06-21', LONDON_LAT);
    expect(sunrise).toBeLessThan(12);
    expect(sunset).toBeGreaterThan(12);
  });

  it('returns earlier sunrise in summer than winter for UK', () => {
    const summer = getSunTimes('2026-06-21', LONDON_LAT);
    const winter = getSunTimes('2026-12-21', LONDON_LAT);
    expect(summer.sunrise).toBeLessThan(winter.sunrise);
  });

  it('returns later sunset in summer than winter for UK', () => {
    const summer = getSunTimes('2026-06-21', LONDON_LAT);
    const winter = getSunTimes('2026-12-21', LONDON_LAT);
    expect(summer.sunset).toBeGreaterThan(winter.sunset);
  });

  it('returns longer daylight in summer than winter', () => {
    const summer = getSunTimes('2026-06-21', LONDON_LAT);
    const winter = getSunTimes('2026-12-21', LONDON_LAT);
    const summerDay = summer.sunset - summer.sunrise;
    const winterDay = winter.sunset - winter.sunrise;
    expect(summerDay).toBeGreaterThan(winterDay);
  });

  it('returns approximately equal day/night at equinox', () => {
    const { sunrise, sunset } = getSunTimes('2026-03-20', LONDON_LAT);
    const daylightHours = sunset - sunrise;
    expect(daylightHours).toBeGreaterThan(11);
    expect(daylightHours).toBeLessThan(13);
  });

  it('returns polar night (sunrise=12, sunset=12) for high Arctic in winter', () => {
    const result = getSunTimes('2026-12-21', 89);
    expect(result).toEqual({ sunrise: 12, sunset: 12 });
  });

  it('returns midnight sun (sunrise=0, sunset=24) for high Arctic in summer', () => {
    const result = getSunTimes('2026-06-21', 89);
    expect(result).toEqual({ sunrise: 0, sunset: 24 });
  });

  it('returns sunrise and sunset as numbers', () => {
    const { sunrise, sunset } = getSunTimes('2026-06-21', LONDON_LAT);
    expect(typeof sunrise).toBe('number');
    expect(typeof sunset).toBe('number');
  });

  it('returns sensible sunrise time for London in June (before 5am)', () => {
    const { sunrise } = getSunTimes('2026-06-21', LONDON_LAT);
    expect(sunrise).toBeLessThan(5);
    expect(sunrise).toBeGreaterThan(0);
  });

  it('returns sensible sunset time for London in June (after 8pm)', () => {
    const { sunset } = getSunTimes('2026-06-21', LONDON_LAT);
    expect(sunset).toBeGreaterThan(20);
    expect(sunset).toBeLessThan(24);
  });

  it('returns sensible sunrise for London in December (after 7am)', () => {
    const { sunrise } = getSunTimes('2026-12-21', LONDON_LAT);
    expect(sunrise).toBeGreaterThan(7);
    expect(sunrise).toBeLessThan(10);
  });
});

// ── getDayHourRange ───────────────────────────────────────────────────────────

describe('getDayHourRange', () => {
  const LONDON_LAT = 51.5;

  it('returns start and end as integers', () => {
    const { start, end } = getDayHourRange('2026-06-21', LONDON_LAT);
    expect(Number.isInteger(start)).toBe(true);
    expect(Number.isInteger(end)).toBe(true);
  });

  it('start is always >= 0', () => {
    const { start } = getDayHourRange('2026-12-21', LONDON_LAT);
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it('end is always <= 23', () => {
    const { end } = getDayHourRange('2026-06-21', LONDON_LAT);
    expect(end).toBeLessThanOrEqual(23);
  });

  it('range is wider in summer than winter', () => {
    const summer = getDayHourRange('2026-06-21', LONDON_LAT);
    const winter = getDayHourRange('2026-12-21', LONDON_LAT);
    const summerSpan = summer.end - summer.start;
    const winterSpan = winter.end - winter.start;
    expect(summerSpan).toBeGreaterThan(winterSpan);
  });

  it('clamps start to 0 even for polar midnight sun', () => {
    // Very high latitude in summer: sunrise ~0 → start = max(0, floor(0)-1) = 0
    const { start } = getDayHourRange('2026-06-21', 89);
    expect(start).toBe(0);
  });

  it('clamps end to 23 even for polar midnight sun', () => {
    const { end } = getDayHourRange('2026-06-21', 89);
    expect(end).toBe(23);
  });
});

// ── darknessAlpha ─────────────────────────────────────────────────────────────

describe('darknessAlpha', () => {
  const SUN = { sunrise: 6, sunset: 20 };

  it('returns max darkness (0.88) well before sunrise', () => {
    expect(darknessAlpha(0, SUN)).toBe(0.88);
    expect(darknessAlpha(3, SUN)).toBe(0.88);
  });

  it('returns max darkness at the start of the dawn fade boundary', () => {
    // sunrise - fadeDur = 6 - 1.5 = 4.5
    expect(darknessAlpha(4.5, SUN)).toBe(0.88);
  });

  it('returns max darkness (0.88) well after sunset', () => {
    expect(darknessAlpha(23, SUN)).toBe(0.88);
  });

  it('returns max darkness at the end of the dusk fade boundary', () => {
    // sunset + fadeDur = 20 + 1.5 = 21.5
    expect(darknessAlpha(21.5, SUN)).toBe(0.88);
  });

  it('returns 0 (full light) during midday', () => {
    expect(darknessAlpha(12, SUN)).toBe(0);
  });

  it('returns 0 exactly at sunrise + fadeDur', () => {
    // sunrise + fadeDur = 7.5
    expect(darknessAlpha(7.5, SUN)).toBe(0);
  });

  it('returns 0 exactly at sunset - fadeDur', () => {
    // sunset - fadeDur = 18.5
    expect(darknessAlpha(18.5, SUN)).toBe(0);
  });

  it('returns partial darkness mid-dawn fade', () => {
    // hour=6 (midpoint of dawn fade [4.5..7.5]): t=0.5, alpha=0.88*0.5=0.44
    expect(darknessAlpha(6, SUN)).toBeCloseTo(0.44);
  });

  it('returns partial darkness mid-dusk fade', () => {
    // hour=20 (midpoint of dusk fade [18.5..21.5]): t=0.5, alpha=0.88*0.5=0.44
    expect(darknessAlpha(20, SUN)).toBeCloseTo(0.44);
  });

  it('returns alpha in [0, 0.88] for all hours', () => {
    for (let h = 0; h <= 24; h++) {
      const a = darknessAlpha(h, SUN);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(0.88);
    }
  });

  it('is monotonically decreasing during dawn', () => {
    const hours = [4.5, 5, 5.5, 6, 6.5, 7, 7.5];
    const alphas = hours.map(h => darknessAlpha(h, SUN));
    for (let i = 0; i < alphas.length - 1; i++) {
      expect(alphas[i]).toBeGreaterThanOrEqual(alphas[i + 1]);
    }
  });

  it('is monotonically increasing during dusk', () => {
    const hours = [18.5, 19, 19.5, 20, 20.5, 21, 21.5];
    const alphas = hours.map(h => darknessAlpha(h, SUN));
    for (let i = 0; i < alphas.length - 1; i++) {
      expect(alphas[i]).toBeLessThanOrEqual(alphas[i + 1]);
    }
  });
});

// ── computeBestWindow ─────────────────────────────────────────────────────────

describe('computeBestWindow', () => {
  const perfectHour = (hour) => ({
    hour,
    temp: 18,
    weatherCode: 0,
    windMph: 0,
    seaLevel: 0,
  });

  it('returns null for null hours', () => {
    expect(computeBestWindow(null, 0, 2, null)).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(computeBestWindow([], 0, 2, null)).toBeNull();
  });

  it('returns null when only 1 hour provided', () => {
    expect(computeBestWindow([perfectHour(10)], 0, 2, null)).toBeNull();
  });

  it('returns a window when 2 valid hours provided', () => {
    const hours = [perfectHour(10), perfectHour(11)];
    const result = computeBestWindow(hours, 0, 2, null);
    expect(result).not.toBeNull();
    expect(result.startIdx).toBe(0);
    expect(result.endIdx).toBe(1);
  });

  it('prefers a 3-hour window over 2-hour due to 3% bonus', () => {
    const hours = [perfectHour(10), perfectHour(11), perfectHour(12)];
    const result = computeBestWindow(hours, 0, 2, null);
    expect(result).not.toBeNull();
    expect(result.endIdx - result.startIdx).toBe(2); // 3-hour window
  });

  it('returns correct startHour and endHour', () => {
    const hours = [perfectHour(10), perfectHour(11), perfectHour(12)];
    const result = computeBestWindow(hours, 0, 2, null);
    expect(result.startHour).toBe(10);
    expect(result.endHour).toBe(12);
  });

  it('returns scores array with same length as hours', () => {
    const hours = [perfectHour(10), perfectHour(11), perfectHour(12)];
    const result = computeBestWindow(hours, 0, 2, null);
    expect(result.scores).toHaveLength(3);
  });

  it('scores perfect conditions (clear sky, no wind, 18°C, low tide) near 1.0', () => {
    const hours = [perfectHour(10), perfectHour(11)];
    const result = computeBestWindow(hours, 0, 2, null);
    // sand=1 (seaLevel=0, seaMin=0), wx=1, wind=1, temp=1 → score=1.0
    expect(result.scores[0]).toBeCloseTo(1.0);
  });

  it('scores dark hours as 0', () => {
    const polarNight = { sunrise: 12, sunset: 12 };
    const hours = [perfectHour(6), perfectHour(7), perfectHour(8)];
    // All hours are dark in polar night (darknessAlpha ≥ 0.8)
    const result = computeBestWindow(hours, 0, 2, polarNight);
    expect(result).toBeNull();
  });

  it('excludes windows containing a zero-scored (dark) hour', () => {
    // Hour 2 is dark (before sunrise), hours 10 and 11 are light
    const sunTimes = { sunrise: 6, sunset: 20 };
    const hours = [perfectHour(2), perfectHour(10), perfectHour(11)];
    const result = computeBestWindow(hours, 0, 2, sunTimes);
    expect(result).not.toBeNull();
    expect(result.startIdx).toBe(1); // window starts at the daylight hours
  });

  it('penalises high wind speed', () => {
    const windyHour = { hour: 10, temp: 18, weatherCode: 0, windMph: 35, seaLevel: 0 };
    const calmHour = { ...windyHour, windMph: 0 };
    const resultCalm = computeBestWindow([calmHour, { ...calmHour, hour: 11 }], 0, 2, null);
    const resultWindy = computeBestWindow([windyHour, { ...windyHour, hour: 11 }], 0, 2, null);
    expect(resultCalm.scores[0]).toBeGreaterThan(resultWindy.scores[0]);
  });

  it('gives score 0 for wind at or above 35 mph', () => {
    const hours = [
      { hour: 10, temp: 18, weatherCode: 0, windMph: 35, seaLevel: 0 },
      { hour: 11, temp: 18, weatherCode: 0, windMph: 35, seaLevel: 0 },
    ];
    const result = computeBestWindow(hours, 0, 2, null);
    // wind component = max(0, 1 - 35/35) = 0, but other factors still contribute
    // sand=1, wx=1, wind=0, temp=1 → 0.30+0.25+0+0.20 = 0.75
    expect(result.scores[0]).toBeCloseTo(0.75);
  });

  it('scores temperature optimally at 18°C', () => {
    const optimal = { hour: 10, temp: 18, weatherCode: 0, windMph: 0, seaLevel: 0 };
    const cold = { hour: 10, temp: 0, weatherCode: 0, windMph: 0, seaLevel: 0 };
    const rOptimal = computeBestWindow([optimal, { ...optimal, hour: 11 }], 0, 2, null);
    const rCold = computeBestWindow([cold, { ...cold, hour: 11 }], 0, 2, null);
    expect(rOptimal.scores[0]).toBeGreaterThan(rCold.scores[0]);
  });

  it('gives higher score for low tide (more sand)', () => {
    const lowTide = { hour: 10, temp: 18, weatherCode: 0, windMph: 0, seaLevel: 0 };
    const highTide = { hour: 10, temp: 18, weatherCode: 0, windMph: 0, seaLevel: 2 };
    const rLow = computeBestWindow([lowTide, { ...lowTide, hour: 11 }], 0, 2, null);
    const rHigh = computeBestWindow([highTide, { ...highTide, hour: 11 }], 0, 2, null);
    expect(rLow.scores[0]).toBeGreaterThan(rHigh.scores[0]);
  });

  it('handles seaRange = 0 without dividing by zero', () => {
    const hours = [perfectHour(10), perfectHour(11)];
    // seaMin = seaMax = 1 → seaRange = 0, falls back to 1
    expect(() => computeBestWindow(hours, 1, 1, null)).not.toThrow();
  });

  it('defaults to minSand=0, maxSand=1 when beachProfile omitted', () => {
    const hours = [perfectHour(10), perfectHour(11)];
    const result = computeBestWindow(hours, 0, 2, null);
    expect(result.scores[0]).toBeCloseTo(1.0);
  });

  it('uses beachProfile.minSand as sand floor at high tide', () => {
    const highTide = { hour: 10, temp: 18, weatherCode: 0, windMph: 0, seaLevel: 2 };
    const r = computeBestWindow([highTide, { ...highTide, hour: 11 }], 0, 2, null, { minSand: 0.5 });
    // tideFraction=1, sand = 0.5 + (1-0.5)*(1-1) = 0.5
    // score = 0.5*0.30 + 1*0.25 + 1*0.25 + 1*0.20 = 0.85
    expect(r.scores[0]).toBeCloseTo(0.85);
  });

  it('uses beachProfile.maxSand as sand ceiling at low tide', () => {
    const lowTide = { hour: 10, temp: 18, weatherCode: 0, windMph: 0, seaLevel: 0 };
    const r = computeBestWindow([lowTide, { ...lowTide, hour: 11 }], 0, 2, null, { maxSand: 0.5 });
    // tideFraction=0, sand = 0 + (0.5-0)*(1-0) = 0.5
    // score = 0.5*0.30 + 1*0.25 + 1*0.25 + 1*0.20 = 0.85
    expect(r.scores[0]).toBeCloseTo(0.85);
  });

  it('beach with minSand=0.4 scores higher at high tide than default beach', () => {
    const highTide = { hour: 10, temp: 18, weatherCode: 0, windMph: 0, seaLevel: 2 };
    const rDefault = computeBestWindow([highTide, { ...highTide, hour: 11 }], 0, 2, null);
    const rWide = computeBestWindow([highTide, { ...highTide, hour: 11 }], 0, 2, null, { minSand: 0.4 });
    expect(rWide.scores[0]).toBeGreaterThan(rDefault.scores[0]);
  });

  it('beach with minSand=0.4 at high tide still scores lower than at low tide', () => {
    const lowTide = { hour: 10, temp: 18, weatherCode: 0, windMph: 0, seaLevel: 0 };
    const highTide = { hour: 10, temp: 18, weatherCode: 0, windMph: 0, seaLevel: 2 };
    const profile = { minSand: 0.4 };
    const rLow = computeBestWindow([lowTide, { ...lowTide, hour: 11 }], 0, 2, null, profile);
    const rHigh = computeBestWindow([highTide, { ...highTide, hour: 11 }], 0, 2, null, profile);
    expect(rLow.scores[0]).toBeGreaterThan(rHigh.scores[0]);
  });

  it('picks the best window among multiple candidates', () => {
    // First 2 hours are bad (stormy), last 3 are perfect
    const bad = (hour) => ({ hour, temp: 0, weatherCode: 95, windMph: 35, seaLevel: 2 });
    const good = (hour) => perfectHour(hour);
    const hours = [bad(8), bad(9), good(10), good(11), good(12)];
    const result = computeBestWindow(hours, 0, 2, null);
    expect(result.startIdx).toBe(2);
  });

  it('returns null when all hours are dark', () => {
    const sunTimes = { sunrise: 12, sunset: 12 }; // polar night
    const hours = Array.from({ length: 5 }, (_, i) => perfectHour(i));
    expect(computeBestWindow(hours, 0, 2, sunTimes)).toBeNull();
  });
});

// ── extractDayData ────────────────────────────────────────────────────────────

function buildMockData(dates = ['2026-06-21']) {
  const times = [], temp = [], weatherCode = [], wind = [], gusts = [], precip = [];
  const seaLevel = [], waveHeight = [], sst = [];

  for (const date of dates) {
    for (let h = 0; h < 24; h++) {
      times.push(`${date}T${String(h).padStart(2, '0')}:00`);
      temp.push(18);
      weatherCode.push(0);
      wind.push(16.0934); // exactly 10 mph
      gusts.push(19.312); // exactly 12 mph — not enough for showGust
      precip.push(0);
      seaLevel.push(1.0 + Math.sin(h * Math.PI / 12));
      waveHeight.push(0.5);
      sst.push(15.0);
    }
  }

  return {
    weather: {
      hourly: {
        time: times,
        temperature_2m: temp,
        weather_code: weatherCode,
        wind_speed_10m: wind,
        wind_gusts_10m: gusts,
        precipitation: precip,
      },
    },
    marine: {
      hourly: {
        time: times,
        sea_level_height_msl: seaLevel,
        wave_height: waveHeight,
        sea_surface_temperature: sst,
      },
    },
  };
}

describe('extractDayData', () => {
  const LAT = 51.5; // London-ish

  it('returns null for an out-of-range dayIdx', () => {
    const data = buildMockData(['2026-06-21']);
    expect(extractDayData(data, 5, LAT)).toBeNull();
  });

  it('returns a result object for a valid dayIdx', () => {
    const data = buildMockData(['2026-06-21']);
    const result = extractDayData(data, 0, LAT);
    expect(result).not.toBeNull();
  });

  it('sets the correct date', () => {
    const data = buildMockData(['2026-06-21']);
    const result = extractDayData(data, 0, LAT);
    expect(result.date).toBe('2026-06-21');
  });

  it('returns hours only within daylight range', () => {
    const data = buildMockData(['2026-06-21']);
    const result = extractDayData(data, 0, LAT);
    const { hoursStart, hoursEnd } = result;
    for (const h of result.hours) {
      expect(h.hour).toBeGreaterThanOrEqual(hoursStart);
      expect(h.hour).toBeLessThanOrEqual(hoursEnd);
    }
  });

  it('converts wind speed from km/h to mph', () => {
    const data = buildMockData(['2026-06-21']);
    const result = extractDayData(data, 0, LAT);
    // 16.0934 km/h ≈ 10 mph
    expect(result.hours[0].windMph).toBe(10);
  });

  it('sets showGust to false when gusts are not significant', () => {
    const data = buildMockData(['2026-06-21']);
    const result = extractDayData(data, 0, LAT);
    // gusts ~12 mph, base wind ~10 mph: 12 < 25 → showGust = false
    expect(result.hours[0].showGust).toBe(false);
  });

  it('sets showGust to true when gusts exceed threshold', () => {
    const data = buildMockData(['2026-06-21']);
    // Set wind to 10 mph (16.09 km/h) and gusts to 40 mph (64.37 km/h)
    data.weather.hourly.wind_speed_10m.fill(16.0934);
    data.weather.hourly.wind_gusts_10m.fill(64.3738);
    const result = extractDayData(data, 0, LAT);
    expect(result.hours[0].showGust).toBe(true);
  });

  it('calculates seaMin and seaMax across the full marine data', () => {
    const data = buildMockData(['2026-06-21']);
    const result = extractDayData(data, 0, LAT);
    const allSea = data.marine.hourly.sea_level_height_msl;
    expect(result.seaMin).toBeCloseTo(Math.min(...allSea));
    expect(result.seaMax).toBeCloseTo(Math.max(...allSea));
  });

  it('calculates avgSST as the average of sea surface temps in the daylight window', () => {
    const data = buildMockData(['2026-06-21']);
    const result = extractDayData(data, 0, LAT);
    // All SST values are 15.0
    expect(result.avgSST).toBeCloseTo(15.0);
  });

  it('returns avgSST as null when no SST data present', () => {
    const data = buildMockData(['2026-06-21']);
    data.marine.hourly.sea_surface_temperature = null;
    const result = extractDayData(data, 0, LAT);
    expect(result.avgSST).toBeNull();
  });

  it('returns seaLevel = 0 when marine time has no matching entry', () => {
    const data = buildMockData(['2026-06-21']);
    // Empty the marine times so no mi will be found
    data.marine.hourly.time = [];
    data.marine.hourly.sea_level_height_msl = [];
    data.marine.hourly.wave_height = [];
    data.marine.hourly.sea_surface_temperature = [];
    const result = extractDayData(data, 0, LAT);
    expect(result.hours.every(h => h.seaLevel === 0)).toBe(true);
  });

  it('includes the dates array listing all unique dates in the data', () => {
    const data = buildMockData(['2026-06-21', '2026-06-22']);
    const result = extractDayData(data, 0, LAT);
    expect(result.dates).toContain('2026-06-21');
    expect(result.dates).toContain('2026-06-22');
  });

  it('extracts the correct day when multiple days are present', () => {
    const data = buildMockData(['2026-06-21', '2026-06-22']);
    const result = extractDayData(data, 1, LAT);
    expect(result.date).toBe('2026-06-22');
  });

  it('sets precip to 0 when precipitation value is falsy', () => {
    const data = buildMockData(['2026-06-21']);
    data.weather.hourly.precipitation.fill(0);
    const result = extractDayData(data, 0, LAT);
    expect(result.hours.every(h => h.precip === 0)).toBe(true);
  });

  it('falls back to wind speed when wind_gusts_10m is absent', () => {
    const data = buildMockData(['2026-06-21']);
    delete data.weather.hourly.wind_gusts_10m;
    const result = extractDayData(data, 0, LAT);
    // gustMph should equal windMph when no gusts data
    expect(result.hours[0].gustMph).toBe(result.hours[0].windMph);
  });
});
