// netlify/functions/propagate-curves.js
//
// INGESTION ONLY — fetch free market data from the internet and append to
// Supabase. Runs on deploy + hourly schedule. Charts never call this.
//
// Model: seed history into the DB once (chunked over a few runs), then only
// add new days going forward. Data only ever grows.

import { sbFetchAll, sbCount } from './lib/supabase-paginate.js';

const METALS_DEV_API_KEY = process.env.METALS_DEV_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BACKFILL_YEARS = 50;
const CHUNK_DAYS = 29;
const MAX_CHUNKS = 500;
const BINANCE_START_MS = {
  BTC: Date.parse('2017-08-17T00:00:00Z'),
  ETH: Date.parse('2017-08-17T00:00:00Z'),
  CFX: Date.parse('2021-05-01T00:00:00Z'),
};
const CRYPTO = ['BTC', 'ETH', 'CFX'];
const BINANCE_SYMBOL = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', CFX: 'CFXUSDT' };

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
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function getMetalRows(asset) {
  return sbFetchAll(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    `metal_price_history?select=recorded_at&asset=eq.${asset}&order=recorded_at.asc`
  );
}

async function getCryptoRows(asset) {
  return sbFetchAll(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    `crypto_price_history?select=recorded_at&asset=eq.${asset}&order=recorded_at.asc`
  );
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
  const startStr = formatDate(startDate);
  const endStr = formatDate(endDate);
  if (startStr > endStr) return {};
  const url = `https://api.metals.dev/v1/timeseries?api_key=${METALS_DEV_API_KEY}&start_date=${startStr}&end_date=${endStr}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Metals.Dev ${res.status}: ${data.error_message || res.statusText}`);
  if (data.status !== 'success') throw new Error(data.error_message || 'Metals.Dev error');
  return data.rates || {};
}

async function propagateMetals() {
  if (!METALS_DEV_API_KEY) return { ok: false, error: 'METALS_DEV_API_KEY not set' };

  const latest = metalsDevLatest();
  const oldestWanted = new Date();
  oldestWanted.setFullYear(oldestWanted.getFullYear() - BACKFILL_YEARS);
  oldestWanted.setUTCHours(0, 0, 0, 0);

  const xau = await getMetalRows('XAU');
  const have = new Set(xau.map((r) => formatDate(r.recorded_at)));

  let cursor = new Date(oldestWanted);
  while (cursor <= latest && have.has(formatDate(cursor))) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  let added = 0;
  let chunks = 0;

  while (cursor <= latest && chunks < MAX_CHUNKS) {
    let chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_DAYS - 1);
    if (chunkEnd > latest) chunkEnd = new Date(latest);

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

    cursor.setUTCDate(cursor.getUTCDate() + CHUNK_DAYS);
    chunks++;
  }

  const total = await sbCount(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, 'metal_price_history', 'asset=eq.XAU');
  const gapRemaining = Math.max(0, Math.ceil((latest - cursor) / 86400000));
  return { ok: true, added, total, chunks, gapRemaining, complete: cursor > latest };
}

async function fetchBinanceKlines(symbol, startTimeMs, limit = 1000) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&startTime=${startTimeMs}&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetis/1.0)' } });
  if (!res.ok) throw new Error(`Binance ${symbol} HTTP ${res.status}`);
  return res.json();
}

async function propagateCrypto(asset) {
  const symbol = BINANCE_SYMBOL[asset];
  if (!symbol) throw new Error(`No Binance symbol for ${asset}`);

  const oldestMs = BINANCE_START_MS[asset] || Date.parse('2017-01-01T00:00:00Z');
  const stored = await getCryptoRows(asset);
  const have = new Set(stored.map((r) => formatDate(r.recorded_at)));

  let cursorMs = oldestMs;
  while (have.has(formatDate(cursorMs))) cursorMs += 86400000;

  let added = 0;
  let pages = 0;

  while (cursorMs < Date.now()) {
    pages++;
    const klines = await fetchBinanceKlines(symbol, cursorMs, 1000);
    if (!Array.isArray(klines) || klines.length === 0) break;

    for (const k of klines) {
      const openTime = k[0];
      const close = Number(k[4]);
      const day = formatDate(openTime);
      if (!have.has(day) && Number.isFinite(close)) {
        await upsertCrypto(asset, close, day);
        have.add(day);
        added++;
      }
      cursorMs = openTime + 86400000;
    }

    if (klines.length < 1000) break;
  }

  const total = await sbCount(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, 'crypto_price_history', `asset=eq.${asset}`);
  return { ok: true, added, total, pages, complete: cursorMs >= Date.now() - 86400000, source: 'binance' };
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), { status: 500 });
  }

  const results = { metals: null, crypto: {} };

  try { results.metals = await propagateMetals(); } catch (e) { results.metals = { ok: false, error: e.message }; }

  for (const asset of CRYPTO) {
    try { results.crypto[asset] = await propagateCrypto(asset); }
    catch (e) { results.crypto[asset] = { ok: false, error: e.message }; }
  }

  console.log('propagate-curves:', JSON.stringify(results));

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
