// netlify/functions/crypto-feed.js
//
// On-demand function — proxies CoinGecko chart requests server-side.
//
// Why this exists: the dashboard was hitting CoinGecko directly from the
// browser (keyless tier: 5-15 calls/min) for both the live ticker AND
// historical chart data. Combined with repeated page loads during testing,
// that triggered CoinGecko's rate limit (429), which then escalated to a
// 401 after repeated hits. Per CoinGecko's own docs, the fix is twofold:
//   1. Use a free Demo API key (100 calls/min, 10,000/month, no card needed)
//      instead of the anonymous keyless tier.
//   2. Cache responses server-side so repeated page loads don't each trigger
//      a fresh CoinGecko call.
//
// Required Netlify env var:
//   COINGECKO_API_KEY -> Demo API key from CoinGecko Developer Dashboard

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

// Simple in-memory cache. Note: Netlify Functions are stateless between cold
// starts, so this only helps within a single warm instance's lifetime —
// it's a "best effort" cache, not a guarantee, but it meaningfully reduces
// calls during bursts of traffic (e.g. multiple chart tabs loading at once).
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds, matches CoinGecko's own data refresh cadence

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data) {
  cache.set(key, { data, time: Date.now() });
}

function withApiKey(url) {
  if (!COINGECKO_API_KEY) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}x_cg_demo_api_key=${COINGECKO_API_KEY}`;
}

export default async (req) => {
  const url = new URL(req.url);
  const type = url.searchParams.get('type');

  try {
    if (type === 'spot') {
      const cacheKey = 'spot:btc-eth-cfx';
      const cached = getCached(cacheKey);
      if (cached) {
        return new Response(JSON.stringify({ ok: true, ...cached }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const cgUrl = withApiKey('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,conflux-token&vs_currencies=usd&include_24hr_change=true');
      const res = await fetch(cgUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/1.0)' }
      });
      if (!res.ok) throw new Error(`CoinGecko spot fetch failed: ${res.status}`);
      const data = await res.json();
      if (!data.bitcoin?.usd) throw new Error('CoinGecko spot returned no data');

      setCached(cacheKey, data);

      return new Response(JSON.stringify({ ok: true, ...data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (type === 'chart') {
      const id = url.searchParams.get('id');
      const daysParam = url.searchParams.get('days');
      const days = daysParam === 'max' ? 'max' : daysParam;
      if (!id) throw new Error('Missing id parameter');

      const cacheKey = `chart:${id}:${days}`;
      const cached = getCached(cacheKey);
      if (cached) {
        return new Response(JSON.stringify({ ok: true, prices: cached, source: 'coingecko-cached' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const interval = days !== 'max' && +days >= 2 && +days <= 30 ? '&interval=hourly' : '';
      const cgUrl = withApiKey(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}${interval}`);

      const res = await fetch(cgUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/1.0)' }
      });
      if (!res.ok) throw new Error(`CoinGecko fetch failed: ${res.status}`);
      const data = await res.json();
      if (!data.prices?.length) throw new Error('CoinGecko returned no price data');

      setCached(cacheKey, data.prices);

      return new Response(JSON.stringify({ ok: true, prices: data.prices, source: 'coingecko' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    throw new Error(`Unknown or missing type parameter: ${type}`);
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
