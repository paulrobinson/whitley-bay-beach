import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker, { getAllowedOrigin, buildUpstreamUrl } from './index.js';

// ── getAllowedOrigin ───────────────────────────────────────────────────────────

describe('getAllowedOrigin', () => {
  it('returns the matched origin for each allowed origin', () => {
    expect(getAllowedOrigin('https://beachwalk.uk')).toBe('https://beachwalk.uk');
    expect(getAllowedOrigin('https://www.beachwalk.uk')).toBe('https://www.beachwalk.uk');
    expect(getAllowedOrigin('https://paulrobinson.github.io')).toBe('https://paulrobinson.github.io');
  });

  it('returns the first allowed origin for unknown origins', () => {
    expect(getAllowedOrigin('https://evil.com')).toBe('https://beachwalk.uk');
    expect(getAllowedOrigin('')).toBe('https://beachwalk.uk');
  });
});

// ── buildUpstreamUrl ──────────────────────────────────────────────────────────

describe('buildUpstreamUrl', () => {
  it('routes /weather to the free Open-Meteo weather endpoint without API key', () => {
    const url = buildUpstreamUrl('/weather', new URLSearchParams({ latitude: '51.5', longitude: '-0.1' }), null);
    expect(url.hostname).toBe('api.open-meteo.com');
    expect(url.pathname).toBe('/v1/forecast');
    expect(url.searchParams.get('latitude')).toBe('51.5');
    expect(url.searchParams.get('longitude')).toBe('-0.1');
  });

  it('routes /marine to the free Open-Meteo marine endpoint without API key', () => {
    const url = buildUpstreamUrl('/marine', new URLSearchParams({ latitude: '51.5' }), null);
    expect(url.hostname).toBe('marine-api.open-meteo.com');
    expect(url.pathname).toBe('/v1/marine');
  });

  it('routes /weather to the commercial endpoint when API key is provided', () => {
    const url = buildUpstreamUrl('/weather', new URLSearchParams(), 'test-key');
    expect(url.hostname).toBe('customer-api.open-meteo.com');
    expect(url.searchParams.get('apikey')).toBe('test-key');
  });

  it('routes /marine to the commercial marine endpoint when API key is provided', () => {
    const url = buildUpstreamUrl('/marine', new URLSearchParams(), 'test-key');
    expect(url.hostname).toBe('customer-marine-api.open-meteo.com');
    expect(url.searchParams.get('apikey')).toBe('test-key');
  });

  it('returns null for unknown paths', () => {
    expect(buildUpstreamUrl('/unknown', new URLSearchParams(), null)).toBeNull();
    expect(buildUpstreamUrl('/', new URLSearchParams(), null)).toBeNull();
  });

  it('passes all query params through to the upstream URL', () => {
    const params = new URLSearchParams({ latitude: '55', longitude: '-1.4', forecast_days: '4', timezone: 'Europe/London' });
    const url = buildUpstreamUrl('/weather', params, null);
    expect(url.searchParams.get('latitude')).toBe('55');
    expect(url.searchParams.get('longitude')).toBe('-1.4');
    expect(url.searchParams.get('forecast_days')).toBe('4');
    expect(url.searchParams.get('timezone')).toBe('Europe/London');
  });

  it('does not add apikey param when API key is absent', () => {
    const url = buildUpstreamUrl('/weather', new URLSearchParams(), null);
    expect(url.searchParams.has('apikey')).toBe(false);
  });
});

// ── fetch handler ─────────────────────────────────────────────────────────────

describe('fetch handler', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ hourly: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ));
  });

  it('responds to OPTIONS preflight with 204 and CORS headers', async () => {
    const req = new Request('https://worker.dev/weather', {
      method: 'OPTIONS',
      headers: { Origin: 'https://beachwalk.uk' },
    });
    const res = await worker.fetch(req, {});
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://beachwalk.uk');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('returns 405 for POST requests', async () => {
    const req = new Request('https://worker.dev/weather', { method: 'POST' });
    const res = await worker.fetch(req, {});
    expect(res.status).toBe(405);
  });

  it('returns 404 for unknown paths', async () => {
    const req = new Request('https://worker.dev/unknown', { method: 'GET' });
    const res = await worker.fetch(req, {});
    expect(res.status).toBe(404);
  });

  it('proxies GET /weather to Open-Meteo and returns 200', async () => {
    const req = new Request('https://worker.dev/weather?latitude=51.5&longitude=-0.1', {
      method: 'GET',
      headers: { Origin: 'https://beachwalk.uk' },
    });
    const res = await worker.fetch(req, {});
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('api.open-meteo.com'));
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('latitude=51.5'));
  });

  it('proxies GET /marine to Open-Meteo marine API', async () => {
    const req = new Request('https://worker.dev/marine?latitude=51.5', {
      method: 'GET',
      headers: { Origin: 'https://beachwalk.uk' },
    });
    await worker.fetch(req, {});
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('marine-api.open-meteo.com'));
  });

  it('uses commercial endpoints when OPENMETEO_API_KEY is set', async () => {
    const req = new Request('https://worker.dev/weather?latitude=51.5', {
      method: 'GET',
      headers: { Origin: 'https://beachwalk.uk' },
    });
    await worker.fetch(req, { OPENMETEO_API_KEY: 'my-secret-key' });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('customer-api.open-meteo.com'));
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('apikey=my-secret-key'));
  });

  it('reflects the request origin in CORS headers for allowed origins', async () => {
    const req = new Request('https://worker.dev/weather', {
      method: 'GET',
      headers: { Origin: 'https://paulrobinson.github.io' },
    });
    const res = await worker.fetch(req, {});
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://paulrobinson.github.io');
  });

  it('falls back to beachwalk.uk in CORS headers for unknown origins', async () => {
    const req = new Request('https://worker.dev/weather', { method: 'GET' });
    const res = await worker.fetch(req, {});
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://beachwalk.uk');
  });

  it('sets Cache-Control on proxied responses', async () => {
    const req = new Request('https://worker.dev/weather', { method: 'GET' });
    const res = await worker.fetch(req, {});
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=900');
  });
});
