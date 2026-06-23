// netlify/functions/seed-history.js
//
// Seeds Supabase with full asset history.
//
// IMPORTANT constraints we hit in production:
// - Metals.Dev quota can be exhausted (400 quota message)
// - Yahoo often blocks datacenter IPs (Netlify) with HTTP 404
// - CoinGecko can 401/429 depending on key / throttling
//
// So this function focuses on crypto seeding using Binance (no key needed),
// and reports clearly when metals must be seeded from a local script.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BACKFILL_YEARS = 10;
const TIME_BUDGET_MS = 24000;
const CRYPTO = ['BTC', 'ETH', 'CFX'];
const BINANCE_SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', CFX: 'CFXUSDT' };

function formatDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function isoDay(tsMs) {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function sbHeaders(extra = {}) {
  return { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, ...extra };
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

async function fetchBinanceKlines(symbol, startTimeMs, limit = 1000) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&startTime=${startTimeMs}&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisSeed/1.0)' } });
  if (!res.ok) throw new Error(`Binance ${symbol} HTTP ${res.status}`);
  return res.json();
}

async function seedCryptoAsset(asset, deadline) {
  const symbol = BINANCE_SYMBOL[asset];
  if (!symbol) throw new Error(`No Binance symbol for ${asset}`);

  const today = new Date();
  const oldest = new Date();
  oldest.setFullYear(oldest.getFullYear() - 5);
  oldest.setUTCHours(0, 0, 0, 0);
  const oldestMs = oldest.getTime();

  const have = await getCryptoDays(asset);
  const target = Math.ceil((today.getTime() - oldestMs) / 86400000);
  if (have.size >= target - 7) return { asset, complete: true, stored: have.size, added: 0, source: 'binance' };

  // Resume from first missing day
  let cursorMs = oldestMs;
  while (have.has(isoDay(cursorMs))) cursorMs += 86400000;

  let added = 0;
  let pages = 0;
  let lastError = null;

  while (cursorMs < Date.now() && Date.now() < deadline) {
    pages++;
    const klines = await fetchBinanceKlines(symbol, cursorMs, 1000);
    if (!Array.isArray(klines) || klines.length === 0) break;

    for (const k of klines) {
      const openTime = k[0];
      const close = Number(k[4]);
      const day = isoDay(openTime);
      if (!have.has(day) && Number.isFinite(close)) {
        await upsertCrypto(asset, close, day);
        have.add(day);
        added++;
      }
      cursorMs = openTime + 86400000;
    }

    // Avoid tight-looping if we’re fully caught up
    if (klines.length < 1000) break;
  }

  const stored = (await getCryptoDays(asset)).size;
  return {
    asset,
    complete: stored >= target - 7,
    stored,
    added,
    pages,
    resumeFrom: stored >= target - 7 ? null : isoDay(cursorMs),
    lastError,
    source: 'binance',
  };
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), { status: 500 });
  }

  const deadline = Date.now() + TIME_BUDGET_MS;
  // Metals seeding cannot reliably run from Netlify due to API quotas and Yahoo 404s from datacenter IPs.
  // We report status only; use scripts/seed-supabase-history.js locally for metals backfill.
  const metals = {
    complete: false,
    stored: 'unknown',
    error: 'Metals backfill must be run locally (Netlify IPs get Yahoo 404 and Metals.Dev quota is exhausted).',
  };

  const crypto = {};
  const url = new URL(globalThis?.location?.href || 'https://seed-history.local');
  const focus = (url.searchParams.get('asset') || '').toUpperCase();
  const assets = CRYPTO.includes(focus) ? [focus] : CRYPTO;

  for (const asset of assets) {
    if (Date.now() >= deadline) { crypto[asset] = { skipped: true }; continue; }
    try { crypto[asset] = await seedCryptoAsset(asset, deadline); }
    catch (e) { crypto[asset] = { error: e.message }; }
  }

  const cryptoDone = Object.values(crypto).every((c) => c.complete || c.skipped);
  const complete = false; // metals cannot complete from this function

  return new Response(JSON.stringify({
    ok: true,
    complete,
    message: complete
      ? 'Supabase fully seeded'
      : 'Crypto seeding runs here (Binance). Metals must be seeded locally: node scripts/seed-supabase-history.js',
    metals,
    crypto,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
