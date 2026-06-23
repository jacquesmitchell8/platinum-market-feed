// netlify/functions/propagate-curves.js
//
// INGESTION ONLY — fetch free market data from the internet and append to
// Supabase. Runs on deploy + hourly schedule. Charts never call this.
//
// Model: seed history into the DB once (chunked over a few runs), then only
// add new days going forward. Data only ever grows.

const METALS_DEV_API_KEY = process.env.METALS_DEV_API_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BACKFILL_YEARS = 10;
const CHUNK_DAYS = 30;
const MAX_CHUNKS = 20;

const METALS = ['XAU', 'XPT'];
const CRYPTO = [
  { asset: 'BTC', geckoId: 'bitcoin' },
  { asset: 'ETH', geckoId: 'ethereum' },
  { asset: 'CFX', geckoId: 'conflux-token' },
];

function formatDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function getMetalRows(asset) {
  const url = `${SUPABASE_URL}/rest/v1/metal_price_history?select=recorded_at&asset=eq.${asset}&order=recorded_at.asc&limit=10000`;
  const res = await fetch(url, { headers: sbHeaders() });
  return res.ok ? res.json() : [];
}

async function getCryptoRows(asset) {
  const url = `${SUPABASE_URL}/rest/v1/crypto_price_history?select=recorded_at&asset=eq.${asset}&order=recorded_at.asc&limit=10000`;
  const res = await fetch(url, { headers: sbHeaders() });
  return res.ok ? res.json() : [];
}

async function upsertMetal(asset, price, dateStr) {
  await fetch(`${SUPABASE_URL}/rest/v1/metal_price_history`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates' }),
    body: JSON.stringify({ asset, price, recorded_at: `${dateStr}T12:00:00Z`, recorded_day: dateStr }),
  });
}

async function upsertCrypto(asset, price, dateStr) {
  await fetch(`${SUPABASE_URL}/rest/v1/crypto_price_history`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates' }),
    body: JSON.stringify({ asset, price, recorded_at: `${dateStr}T12:00:00Z`, recorded_day: dateStr }),
  });
}

async function fetchMetalsDevChunk(startDate, endDate) {
  const url = `https://api.metals.dev/v1/timeseries?api_key=${METALS_DEV_API_KEY}&start_date=${formatDate(startDate)}&end_date=${formatDate(endDate)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Metals.Dev ${res.status}`);
  const data = await res.json();
  if (data.status !== 'success') throw new Error(data.error_message || 'Metals.Dev error');
  return data.rates;
}

async function propagateMetals() {
  if (!METALS_DEV_API_KEY) return { ok: false, error: 'METALS_DEV_API_KEY not set' };

  const today = new Date();
  const oldestWanted = new Date();
  oldestWanted.setFullYear(oldestWanted.getFullYear() - BACKFILL_YEARS);

  const xau = await getMetalRows('XAU');
  const first = xau.length ? new Date(xau[0].recorded_at) : null;
  const last = xau.length ? new Date(xau[xau.length - 1].recorded_at) : null;

  let added = 0;
  let chunks = 0;

  // Backfill older history if the earliest row is still too recent
  if (!first || first > oldestWanted) {
    let cursor = new Date(oldestWanted);
    const end = first && first > oldestWanted ? first : today;
    while (cursor < end && chunks < MAX_CHUNKS) {
      let chunkEnd = new Date(cursor);
      chunkEnd.setDate(chunkEnd.getDate() + CHUNK_DAYS - 1);
      if (chunkEnd > end) chunkEnd = new Date(end);
      try {
        const rates = await fetchMetalsDevChunk(cursor, chunkEnd);
        for (const [dateStr, dayData] of Object.entries(rates)) {
          if (dayData?.metals?.gold != null) { await upsertMetal('XAU', dayData.metals.gold, dateStr); added++; }
          if (dayData?.metals?.platinum != null) { await upsertMetal('XPT', dayData.metals.platinum, dateStr); added++; }
        }
      } catch (err) {
        console.error('metals backfill chunk:', err.message);
      }
      cursor.setDate(cursor.getDate() + CHUNK_DAYS);
      chunks++;
    }
  }

  // Forward fill to today
  if (last && last < today && chunks < MAX_CHUNKS) {
    let cursor = new Date(last);
    while (cursor < today && chunks < MAX_CHUNKS) {
      let chunkEnd = new Date(cursor);
      chunkEnd.setDate(chunkEnd.getDate() + CHUNK_DAYS - 1);
      if (chunkEnd > today) chunkEnd = new Date(today);
      try {
        const rates = await fetchMetalsDevChunk(cursor, chunkEnd);
        for (const [dateStr, dayData] of Object.entries(rates)) {
          if (dayData?.metals?.gold != null) { await upsertMetal('XAU', dayData.metals.gold, dateStr); added++; }
          if (dayData?.metals?.platinum != null) { await upsertMetal('XPT', dayData.metals.platinum, dateStr); added++; }
        }
      } catch (err) {
        console.error('metals forward chunk:', err.message);
      }
      cursor.setDate(cursor.getDate() + CHUNK_DAYS);
      chunks++;
    }
  }

  const total = (await getMetalRows('XAU')).length;
  return { ok: true, added, total, chunks };
}

function withCgKey(url) {
  if (!COINGECKO_API_KEY) return url;
  return `${url}${url.includes('?') ? '&' : '?'}x_cg_demo_api_key=${COINGECKO_API_KEY}`;
}

async function propagateCrypto(asset, geckoId) {
  const today = new Date();
  const oldestWanted = new Date();
  oldestWanted.setFullYear(oldestWanted.getFullYear() - 5);

  const stored = await getCryptoRows(asset);
  const first = stored.length ? new Date(stored[0].recorded_at) : null;
  const last = stored.length ? new Date(stored[stored.length - 1].recorded_at) : null;

  if (first && first <= oldestWanted && last && formatDate(last) >= formatDate(today)) {
    return { ok: true, added: 0, total: stored.length, skipped: true };
  }

  const days = first && first > oldestWanted
    ? Math.ceil((today - oldestWanted) / 86400000) + 2
    : 365 * 5;

  const cgUrl = withCgKey(`https://api.coingecko.com/api/v3/coins/${geckoId}/market_chart?vs_currency=usd&days=${Math.min(days, 1825)}`);
  const res = await fetch(cgUrl, { headers: { 'User-Agent': 'PlatinumMetisBot/1.0' } });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const data = await res.json();

  const byDay = new Map();
  for (const [ts, price] of data.prices || []) {
    byDay.set(formatDate(ts), price);
  }

  const fromStr = !first || first > oldestWanted ? formatDate(oldestWanted) : formatDate(last);
  let added = 0;
  for (const [day, price] of byDay) {
    if (day >= fromStr && day <= formatDate(today)) {
      await upsertCrypto(asset, price, day);
      added++;
    }
  }

  const total = (await getCryptoRows(asset)).length;
  return { ok: true, added, total };
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), { status: 500 });
  }

  const results = { metals: null, crypto: {} };

  try { results.metals = await propagateMetals(); } catch (e) { results.metals = { ok: false, error: e.message }; }

  for (const { asset, geckoId } of CRYPTO) {
    try { results.crypto[asset] = await propagateCrypto(asset, geckoId); }
    catch (e) { results.crypto[asset] = { ok: false, error: e.message }; }
  }

  console.log('propagate-curves:', JSON.stringify(results));

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
