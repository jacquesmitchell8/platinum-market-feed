// netlify/functions/seed-history.js
//
// Run until Supabase history is complete (or Netlify ~26s timeout).
// Hit repeatedly until JSON says complete: true:
//   /.netlify/functions/seed-history
//
// For a guaranteed one-shot full seed with no timeout, use:
//   node scripts/seed-supabase-history.js

const METALS_DEV_API_KEY = process.env.METALS_DEV_API_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BACKFILL_YEARS = 10;
const CHUNK_DAYS = 30;
const TIME_BUDGET_MS = 24000;
const CRYPTO = [
  { asset: 'BTC', geckoId: 'bitcoin' },
  { asset: 'ETH', geckoId: 'ethereum' },
  { asset: 'CFX', geckoId: 'conflux-token' },
];

function formatDate(d) {
  return new Date(d).toISOString().slice(0, 10);
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

async function fetchMetalsChunk(start, end) {
  const url = `https://api.metals.dev/v1/timeseries?api_key=${METALS_DEV_API_KEY}&start_date=${formatDate(start)}&end_date=${formatDate(end)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Metals.Dev ${res.status}`);
  const data = await res.json();
  if (data.status !== 'success') throw new Error(data.error_message || 'Metals.Dev error');
  return data.rates;
}

async function seedMetalsUntilDone(deadline) {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const oldest = new Date();
  oldest.setFullYear(oldest.getFullYear() - BACKFILL_YEARS);
  oldest.setHours(0, 0, 0, 0);

  const have = await getMetalDays();
  let cursor = new Date(oldest);
  while (cursor <= today && have.has(formatDate(cursor))) cursor.setDate(cursor.getDate() + 1);

  let added = 0;
  let chunks = 0;

  while (cursor <= today && Date.now() < deadline) {
    let chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + CHUNK_DAYS - 1);
    if (chunkEnd > today) chunkEnd = new Date(today);

    const rates = await fetchMetalsChunk(cursor, chunkEnd);
    for (const [dateStr, dayData] of Object.entries(rates)) {
      if (dayData?.metals?.gold != null) { await upsertMetal('XAU', dayData.metals.gold, dateStr); have.add(dateStr); added++; }
      if (dayData?.metals?.platinum != null) await upsertMetal('XPT', dayData.metals.platinum, dateStr);
    }
    cursor.setDate(cursor.getDate() + CHUNK_DAYS);
    chunks++;
  }

  const complete = cursor > today;
  return { added, chunks, complete, stored: have.size, resumeFrom: complete ? null : formatDate(cursor) };
}

function cgUrl(path) {
  const base = `https://api.coingecko.com/api/v3/${path}`;
  if (!COINGECKO_API_KEY) return base;
  return `${base}${base.includes('?') ? '&' : '?'}x_cg_demo_api_key=${COINGECKO_API_KEY}`;
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

  const res = await fetch(cgUrl(`coins/${geckoId}/market_chart?vs_currency=usd&days=${Math.min(target, 1825)}`), {
    headers: { 'User-Agent': 'PlatinumMetisSeed/1.0' },
  });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
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
  if (!METALS_DEV_API_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'METALS_DEV_API_KEY not set' }), { status: 500 });
  }

  const deadline = Date.now() + TIME_BUDGET_MS;
  const metals = await seedMetalsUntilDone(deadline);

  const crypto = {};
  for (const { asset, geckoId } of CRYPTO) {
    if (Date.now() >= deadline) { crypto[asset] = { skipped: true }; continue; }
    try { crypto[asset] = await seedCryptoAsset(asset, geckoId); }
    catch (e) { crypto[asset] = { error: e.message }; }
  }

  const complete = metals.complete && Object.values(crypto).every((c) => c.complete || c.skipped);

  return new Response(JSON.stringify({
    ok: true,
    complete,
    message: complete
      ? 'Supabase fully seeded — charts can read complete history'
      : 'Still seeding — call this URL again until complete is true',
    metals,
    crypto,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
