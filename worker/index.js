const ALLOWED_ORIGINS = [
  'https://beachwalk.uk',
  'https://www.beachwalk.uk',
  'https://paulrobinson.github.io',
];

const FREE_UPSTREAM = {
  '/weather': 'https://api.open-meteo.com/v1/forecast',
  '/marine': 'https://marine-api.open-meteo.com/v1/marine',
};

const COMMERCIAL_UPSTREAM = {
  '/weather': 'https://customer-api.open-meteo.com/v1/forecast',
  '/marine': 'https://customer-marine-api.open-meteo.com/v1/marine',
};

export function getAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

export function buildUpstreamUrl(pathname, searchParams, apiKey) {
  const map = apiKey ? COMMERCIAL_UPSTREAM : FREE_UPSTREAM;
  const base = map[pathname];
  if (!base) return null;
  const url = new URL(base);
  searchParams.forEach((value, key) => url.searchParams.set(key, value));
  if (apiKey) url.searchParams.set('apikey', apiKey);
  return url;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';
    const allowedOrigin = getAllowedOrigin(origin);

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    const upstreamUrl = buildUpstreamUrl(url.pathname, url.searchParams, env.OPENMETEO_API_KEY);
    if (!upstreamUrl) {
      return new Response('Not found', { status: 404, headers: corsHeaders });
    }

    const upstream = await fetch(upstreamUrl.toString());

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...corsHeaders,
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
        'Cache-Control': 'public, max-age=900',
      },
    });
  },
};
