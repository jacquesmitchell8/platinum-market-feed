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
const MAX_CHUNKS = 60; // 60 × 30 days ≈ 5 years of gap-fill per run

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
  today.setHours(23, 59, 59, 999);
  const oldestWanted = new Date();
  oldestWanted.setFullYear(oldestWanted.getFullYear() - BACKFILL_YEARS);
  oldestWanted.setHours(0, 0, 0, 0);

  const xau = await getMetalRows('XAU');
  const have = new Set(xau.map((r) => formatDate(r.recorded_at)));

  // Resume from the first missing day — fills holes in the middle, not just edges.
  let cursor = new Date(oldestWanted);
  while (cursor <= today && have.has(formatDate(cursor))) {
    cursor.setDate(cursor.getDate() + 1);
  }

  let added = 0;
  let chunks = 0;

  while (cursor <= today && chunks < MAX_CHUNKS) {
    let chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + CHUNK_DAYS - 1);
    if (chunkEnd > today) chunkEnd = new Date(today);

    try {
      const rates = await fetchMetalsDevChunk(cursor, chunkEnd);
      for (const [dateStr, dayData] of Object.entries(rates)) {
        if (dayData?.metals?.gold != null) {
          await upsertMetal('XAU', dayData.metals.gold, dateStr);
          have.add(dateStr);
          added++;
        }
        if (dayData?.metals?.platinum != null) {
          await upsertMetal('XPT', dayData.metals.platinum, dateStr);
          added++;
        }
      }
    } catch (err) {
      console.error('metals propagate chunk:', err.message);
    }

    cursor.setDate(cursor.getDate() + CHUNK_DAYS);
    chunks++;
  }

  const total = (await getMetalRows('XAU')).length;
  const gapRemaining = Math.max(0, Math.ceil((today - cursor) / 86400000));
  return { ok: true, added, total, chunks, gapRemaining };
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
  const have = new Set(stored.map((r) => formatDate(r.recorded_at)));
  const targetDays = Math.ceil((today - oldestWanted) / 86400000);

  // Re-seed if we're missing more than a week of expected daily rows
  if (have.size >= targetDays - 7) {
    return { ok: true, added: 0, total: stored.length, complete: true };
  }

  const cgUrl = withCgKey(
    `https://api.coingecko.com/api/v3/coins/${geckoId}/market_chart?vs_currency=usd&days=${Math.min(targetDays, 1825)}`
  );
  const res = await fetch(cgUrl, { headers: { 'User-Agent': 'PlatinumMetisBot/1.0' } });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const data = await res.json();

  const byDay = new Map();
  for (const [ts, price] of data.prices || []) {
    byDay.set(formatDate(ts), price);
  }

  let added = 0;
  for (const [day, price] of byDay) {
    if (day >= formatDate(oldestWanted) && day <= formatDate(today) && !have.has(day)) {
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
