// netlify/functions/seed-history.js
//
// Seeds Supabase with full asset history. Hit until complete: true:
//   /.netlify/functions/seed-history
//
// Metals: Metals.Dev (daily) → Yahoo Finance fallback if quota exhausted
// Crypto: CoinGecko (daily)
// Today’s spot: fetch-market-snapshots (separate cron)

const METALS_DEV_API_KEY = process.env.METALS_DEV_API_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BACKFILL_YEARS = 10;
const CHUNK_DAYS = 29;
const TIME_BUDGET_MS = 24000;
const YAHOO_METALS = [
  { asset: 'XAU', yahoo: 'GC=F' },
  { asset: 'XPT', yahoo: 'PL=F' },
];
const CRYPTO = [
  { asset: 'BTC', geckoId: 'bitcoin' },
  { asset: 'ETH', geckoId: 'ethereum' },
  { asset: 'CFX', geckoId: 'conflux-token' },
];

function formatDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function metalsDevLatest() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

function sbHeaders(extra = {}) {
  return { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, ...extra };
}

async function getMetalDays() {
  const url = `${SUPABASE_URL}/rest/v1/metal_price_history?select=recorded_day&asset=eq.XAU&order=recorded_day.asc&limit=10000`;
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) return new Set();
  return new Set((await res.json()).map((r) => r.recorded_day));
}

async function upsertMetal(asset, price, dateStr) {
  await fetch(`${SUPABASE_URL}/rest/v1/metal_price_history`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates' }),
    body: JSON.stringify({ asset, price, recorded_at: `${dateStr}T12:00:00Z`, recorded_day: dateStr }),
  });
}

function isQuotaError(msg) {
  return /quota|exhausted|exceeded|upgrade your plan/i.test(msg || '');
}

async function fetchMetalsDevChunk(start, end) {
  const startStr = formatDate(start);
  const endStr = formatDate(end);
  if (startStr > endStr) return {};
  const url = `https://api.metals.dev/v1/timeseries?api_key=${METALS_DEV_API_KEY}&start_date=${startStr}&end_date=${endStr}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Metals.Dev ${res.status}: ${data.error_message || res.statusText}`);
  if (data.status !== 'success') throw new Error(data.error_message || 'Metals.Dev error');
  return data.rates || {};
}

async function fetchYahooDaily(yahooSymbol, range = '10y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/1.0)' } });
  if (!res.ok) throw new Error(`Yahoo ${yahooSymbol} HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${yahooSymbol} no data`);

  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    points.push({ day: formatDate(timestamps[i] * 1000), price: closes[i] });
  }
  return points;
}

async function seedMetalsFromYahoo(have) {
  let added = 0;
  const results = {};
  for (const { asset, yahoo } of YAHOO_METALS) {
    try {
      const points = await fetchYahooDaily(yahoo, '10y');
      let n = 0;
      for (const p of points) {
        if (!have.has(p.day)) {
          await upsertMetal(asset, p.price, p.day);
          have.add(p.day);
          n++;
          added++;
        }
      }
      results[asset] = { ok: true, added: n, total: points.length };
    } catch (err) {
      results[asset] = { ok: false, error: err.message };
    }
  }
  return { added, results };
}

async function seedMetalsUntilDone(deadline) {
  const latest = metalsDevLatest();
  const oldest = new Date();
  oldest.setFullYear(oldest.getFullYear() - BACKFILL_YEARS);
  oldest.setUTCHours(0, 0, 0, 0);
  const targetDays = Math.ceil((latest - oldest) / 86400000);

  const have = await getMetalDays();
  let added = 0;
  let chunks = 0;
  let lastError = null;
  let source = null;

  // Yahoo bulk fill when storage is thin OR Metals.Dev unavailable
  if (have.size < targetDays * 0.85) {
    const yahoo = await seedMetalsFromYahoo(have);
    added += yahoo.added;
    source = 'yahoo-finance';
    if (yahoo.added > 0) {
      return {
        added,
        chunks: 0,
        complete: have.size >= targetDays - 14,
        stored: have.size,
        targetDays,
        source,
        yahoo: yahoo.results,
        lastError: null,
      };
    }
  }

  let cursor = new Date(oldest);
  while (cursor <= latest && have.has(formatDate(cursor))) cursor.setUTCDate(cursor.getUTCDate() + 1);

  let quotaDead = false;
  while (cursor <= latest && Date.now() < deadline && !quotaDead) {
    let chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_DAYS - 1);
    if (chunkEnd > latest) chunkEnd = new Date(latest);

    try {
      const rates = await fetchMetalsDevChunk(cursor, chunkEnd);
      for (const [dateStr, dayData] of Object.entries(rates)) {
        if (dayData?.metals?.gold != null) { await upsertMetal('XAU', dayData.metals.gold, dateStr); have.add(dateStr); added++; }
        if (dayData?.metals?.platinum != null) await upsertMetal('XPT', dayData.metals.platinum, dateStr);
      }
      source = 'metals.dev';
    } catch (err) {
      lastError = err.message;
      if (isQuotaError(err.message)) {
        quotaDead = true;
        const yahoo = await seedMetalsFromYahoo(have);
        added += yahoo.added;
        source = 'yahoo-finance-fallback';
        return {
          added,
          chunks,
          complete: have.size >= targetDays - 14,
          stored: have.size,
          targetDays,
          source,
          yahoo: yahoo.results,
          lastError,
        };
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + CHUNK_DAYS);
    chunks++;
  }

  return {
    added,
    chunks,
    complete: have.size >= targetDays - 14,
    stored: have.size,
    targetDays,
    source,
    resumeFrom: have.size >= targetDays - 14 ? null : formatDate(cursor),
    lastError,
  };
}

function cgHeaders() {
  const h = { 'User-Agent': 'PlatinumMetisSeed/1.0', Accept: 'application/json' };
  if (COINGECKO_API_KEY) h['x-cg-demo-api-key'] = COINGECKO_API_KEY;
  return h;
}

function cgUrl(path) {
  let url = `https://api.coingecko.com/api/v3/${path}`;
  if (COINGECKO_API_KEY) url += (url.includes('?') ? '&' : '?') + `x_cg_demo_api_key=${COINGECKO_API_KEY}`;
  return url;
}

async function getCryptoDays(asset) {
  const url = `${SUPABASE_URL}/rest/v1/crypto_price_history?select=recorded_day&asset=eq.${asset}&limit=10000`;
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) return new Set();
  return new Set((await res.json()).map((r) => r.recorded_day));
}

async function upsertCrypto(asset, price, dateStr) {
  await fetch(`${SUPABASE_URL}/rest/v1/crypto_price_history`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates' }),
    body: JSON.stringify({ asset, price, recorded_at: `${dateStr}T12:00:00Z`, recorded_day: dateStr }),
  });
}

async function seedCryptoAsset(asset, geckoId) {
  const today = new Date();
  const oldest = new Date();
  oldest.setFullYear(oldest.getFullYear() - 5);
  const have = await getCryptoDays(asset);
  const target = Math.ceil((today - oldest) / 86400000);
  if (have.size >= target - 7) return { asset, complete: true, stored: have.size, added: 0 };

  const days = Math.min(target, 1825);
  let res = await fetch(cgUrl(`coins/${geckoId}/market_chart?vs_currency=usd&days=${days}`), { headers: cgHeaders() });

  // Retry without key if demo key rejected
  if (res.status === 401 && COINGECKO_API_KEY) {
    res = await fetch(`https://api.coingecko.com/api/v3/coins/${geckoId}/market_chart?vs_currency=usd&days=${days}`, {
      headers: { 'User-Agent': 'PlatinumMetisSeed/1.0' },
    });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`CoinGecko ${res.status}${body ? ': ' + body.slice(0, 120) : ''}`);
  }

  const data = await res.json();
  const byDay = new Map();
  for (const [ts, price] of data.prices || []) byDay.set(formatDate(ts), price);

  let added = 0;
  for (const [day, price] of byDay) {
    if (day >= formatDate(oldest) && day <= formatDate(today) && !have.has(day)) {
      await upsertCrypto(asset, price, day);
      added++;
    }
  }
  const stored = (await getCryptoDays(asset)).size;
  return { asset, complete: stored >= target - 7, stored, added };
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), { status: 500 });
  }

  const deadline = Date.now() + TIME_BUDGET_MS;
  let metals;
  try {
    metals = await seedMetalsUntilDone(deadline);
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  const crypto = {};
  for (const { asset, geckoId } of CRYPTO) {
    if (Date.now() >= deadline) { crypto[asset] = { skipped: true }; continue; }
    try { crypto[asset] = await seedCryptoAsset(asset, geckoId); }
    catch (e) { crypto[asset] = { error: e.message }; }
  }

  const cryptoDone = Object.values(crypto).every((c) => c.complete || c.skipped);
  const complete = metals.complete && cryptoDone;

  return new Response(JSON.stringify({
    ok: true,
    complete,
    message: complete
      ? 'Supabase fully seeded'
      : metals.lastError?.includes('quota')
        ? 'Metals.Dev quota exhausted — Yahoo fallback used; refresh once more or fix COINGECKO_API_KEY for crypto'
        : 'Still seeding — call this URL again until complete is true',
    metals,
    crypto,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
