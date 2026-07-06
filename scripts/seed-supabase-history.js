#!/usr/bin/env node
/**
 * ONE-OFF full history seed for Supabase.
 *
 * Setup (once):
 *   1. Copy .env.seed.example → .env.seed
 *   2. Paste real values from Netlify → Environment variables
 *   3. node scripts/seed-supabase-history.js
 *
 * Netlify deploy also runs propagate-curves hourly, but local seed is needed
 * for full metals history (Metals.Dev / Yahoo limits on serverless).
 */

const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env.seed');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Always prefer the project's .env.seed for this one-off script.
    // (Users often have stale env vars from previous runs in their shell.)
    process.env[key] = val;
  }
}

loadEnvFile();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const METALS_DEV_API_KEY = process.env.METALS_DEV_API_KEY; // optional (we prefer Yahoo for metals)
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY; // optional (we prefer Binance for crypto)

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  die(`Missing credentials.

Do NOT use the placeholder text "your-url" / "your-key".

Option A — local seed (recommended):
  1. cp .env.seed.example .env.seed
  2. Open Netlify → your site → Environment variables
  3. Copy the real values into .env.seed
  4. node scripts/seed-supabase-history.js

Option B — after git push:
  Deploy runs propagate-curves automatically; re-run this script locally for full metals backfill.`);
}

if (SUPABASE_URL.includes('your-url') || SUPABASE_SERVICE_ROLE_KEY.includes('your-key')) {
  die('Still using placeholder values in .env.seed — paste your real Netlify env vars.');
}

if (!SUPABASE_URL.startsWith('https://') || !SUPABASE_URL.includes('supabase.co')) {
  die(`SUPABASE_URL looks wrong: ${SUPABASE_URL}`);
}

if (!METALS_DEV_API_KEY && !process.argv.includes('--producers-only')) {
  die('METALS_DEV_API_KEY is required for full seed — use --producers-only for JSE only.');
}

const BACKFILL_YEARS = 50; // run until Metals.Dev / source has no more data
const CHUNK_DAYS = 29;
const METALS = ['XAU', 'XPT'];
const CRYPTO = [
  { asset: 'BTC', geckoId: 'bitcoin' },
  { asset: 'ETH', geckoId: 'ethereum' },
  { asset: 'CFX', geckoId: 'conflux-token' },
];
const PRODUCERS = ['VAL.JO', 'IMP.JO', 'SSW.JO', 'NPH.JO'];

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

const UPSERT_BATCH_SIZE = 500;

const ON_CONFLICT = {
  metal_price_history: 'asset,recorded_day',
  crypto_price_history: 'asset,recorded_day',
  producer_price_history: 'ticker,recorded_day',
};

async function insertBatch(table, rows) {
  if (!rows.length) return true;
  const onConflict = ON_CONFLICT[table];
  const url = onConflict
    ? `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`
    : `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: sbHeaders({
      'Content-Type': 'application/json',
      // With on_conflict set, this becomes a proper upsert on our day-level key.
      Prefer: 'resolution=merge-duplicates',
    }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Supabase insert failed (${table}) HTTP ${res.status}${t ? ': ' + t.slice(0, 180) : ''}`);
  }
  return true;
}

async function insertInBatches(table, rows, batchSize = UPSERT_BATCH_SIZE) {
  for (let i = 0; i < rows.length; i += batchSize) {
    await insertBatch(table, rows.slice(i, i + batchSize));
  }
}

async function countRows(table, filter) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=recorded_day&${filter}`;
  const res = await fetch(url, { headers: { ...sbHeaders(), Prefer: 'count=exact', Range: '0-0' } });
  const range = res.headers.get('content-range') || '';
  const m = range.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

const PAGE_SIZE = 1000;

async function fetchAllRows(table, filter) {
  const out = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=recorded_day,recorded_at&${filter}&order=recorded_at.asc`;
    const res = await fetch(url, {
      headers: { ...sbHeaders(), Range: `${from}-${to}` },
    });
    if (!res.ok) break;
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

async function getDays(table, filter) {
  const rows = await fetchAllRows(table, filter);
  const days = new Set();
  for (const r of rows) {
    if (r.recorded_day) days.add(String(r.recorded_day));
    else if (r.recorded_at) days.add(formatDate(r.recorded_at));
  }
  return days;
}

function mkMetalRow(asset, price, dateStr) {
  return { asset, price, recorded_at: `${dateStr}T12:00:00Z`, recorded_day: dateStr };
}

function mkCryptoRow(asset, price, dateStr) {
  return { asset, price, recorded_at: `${dateStr}T12:00:00Z`, recorded_day: dateStr };
}

function mkProducerRow(ticker, price, dateStr) {
  return { ticker, price, recorded_at: `${dateStr}T12:00:00Z`, recorded_day: dateStr };
}

async function fetchYahooDaily(symbol, range = '10y') {
  // query2 is often more reliable than query1 from some networks.
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  // Yahoo sometimes returns 404 unless the request looks like a real browser request.
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/plain,*/*',
      'Origin': 'https://finance.yahoo.com',
      'Referer': `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
    }
  });
  if (!res.ok) throw new Error(`Yahoo ${symbol} HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${symbol} no data`);
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    points.push({ day: formatDate(timestamps[i] * 1000), price: closes[i] });
  }
  return points;
}

async function fetchFreeGoldApiDaily() {
  // Free, no-key daily gold history. We'll take last 10 years.
  const res = await fetch('https://freegoldapi.com/data/latest.json', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisSeed/1.0)',
      'Accept': 'application/json',
    }
  });
  if (!res.ok) throw new Error(`freegoldapi HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error('freegoldapi returned no rows');
  return rows
    .filter(r => r?.date && typeof r.price === 'number')
    .map(r => ({ day: r.date, price: r.price }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

async function fetchDatahubPlatinumMonthly() {
  // Open data (PDDL) monthly series for platinum (USD/oz).
  const res = await fetch('https://datahub.io/energy-and-commodities/precious-metals-prices/_r/-/data/platinum.csv', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisSeed/1.0)' }
  });
  if (!res.ok) throw new Error(`datahub platinum.csv HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, price] = lines[i].split(',');
    const p = Number(price);
    if (date && Number.isFinite(p)) out.push({ day: date, price: p });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

async function fetchMetalsDevChunk(start, end) {
  if (!METALS_DEV_API_KEY) throw new Error('METALS_DEV_API_KEY not set');
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

async function seedPlatinumFromMetalsDev(cutoffDay) {
  const latest = metalsDevLatest();
  const oldest = new Date(cutoffDay + 'T00:00:00Z');
  const end = latest;

  let cursor = new Date(oldest);
  let added = 0;
  let chunks = 0;

  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + (CHUNK_DAYS - 1));
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    const rates = await fetchMetalsDevChunk(cursor, chunkEnd);
    const rows = [];
    for (const [dateStr, dayData] of Object.entries(rates)) {
      const platinum = dayData?.metals?.platinum;
      if (platinum != null && dateStr >= cutoffDay) {
        rows.push(mkMetalRow('XPT', platinum, dateStr));
      }
    }
    await insertInBatches('metal_price_history', rows);
    added += rows.length;

    cursor.setUTCDate(cursor.getUTCDate() + CHUNK_DAYS);
    chunks++;
    // small pause to be polite
    await sleep(150);
  }

  return { added, chunks };
}

async function seedMetalsDailyFromMetalsDev(cutoffDay, haveXAU, haveXPT) {
  const latest = metalsDevLatest();
  const oldest = new Date(cutoffDay + 'T00:00:00Z');

  let cursor = new Date(oldest);
  let addedXAU = 0;
  let addedXPT = 0;
  let chunks = 0;

  while (cursor <= latest) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + (CHUNK_DAYS - 1));
    if (chunkEnd > latest) chunkEnd.setTime(latest.getTime());

    const rates = await fetchMetalsDevChunk(cursor, chunkEnd);
    const xauRows = [];
    const xptRows = [];
    for (const [dateStr, dayData] of Object.entries(rates)) {
      if (dateStr < cutoffDay) continue;
      const gold = dayData?.metals?.gold;
      const platinum = dayData?.metals?.platinum;
      if (gold != null && !haveXAU.has(dateStr)) xauRows.push(mkMetalRow('XAU', gold, dateStr));
      if (platinum != null && !haveXPT.has(dateStr)) xptRows.push(mkMetalRow('XPT', platinum, dateStr));
    }
    await insertInBatches('metal_price_history', xauRows);
    await insertInBatches('metal_price_history', xptRows);
    for (const r of xauRows) haveXAU.add(r.recorded_day);
    for (const r of xptRows) haveXPT.add(r.recorded_day);
    addedXAU += xauRows.length;
    addedXPT += xptRows.length;

    cursor.setUTCDate(cursor.getUTCDate() + CHUNK_DAYS);
    chunks++;
    await sleep(150);
  }

  return { addedXAU, addedXPT, chunks };
}

async function retry(fn, { tries = 6, baseMs = 2000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const msg = String(e?.message || e);
      // Only backoff for 429 / throttling.
      if (!/\\b429\\b|thrott/i.test(msg)) throw e;
      const wait = baseMs * Math.pow(2, i);
      console.log(`  throttled, waiting ${Math.round(wait/1000)}s…`);
      await sleep(wait);
    }
  }
  throw last;
}

async function seedMetals() {
  const storedXAU = await countRows('metal_price_history', 'asset=eq.XAU');
  const storedXPT = await countRows('metal_price_history', 'asset=eq.XPT');
  console.log(`\n[metals] ${storedXAU} XAU / ${storedXPT} XPT days stored — seeding gaps via Metals.Dev`);

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - BACKFILL_YEARS);
  const cutoffDay = formatDate(cutoff);

  const haveXAU = await getDays('metal_price_history', 'asset=eq.XAU');
  const haveXPT = await getDays('metal_price_history', 'asset=eq.XPT');
  let added = 0;

  // Preferred: daily gold + platinum from Metals.Dev (you upgraded, so this should work)
  try {
    const md = await seedMetalsDailyFromMetalsDev(cutoffDay, haveXAU, haveXPT);
    console.log(`[metals XAU] ${md.addedXAU} new daily rows (Metals.Dev)`);
    console.log(`[metals XPT] ${md.addedXPT} new daily rows (Metals.Dev)`);
    added += md.addedXAU + md.addedXPT;
    const total = await countRows('metal_price_history', 'asset=eq.XAU');
    console.log(`[metals] done — ${total} gold days in Supabase (${added} new this run)`);
    return;
  } catch (err) {
    console.log(`[metals] Metals.Dev failed (${err.message}); using free/open fallbacks.`);
  }

  const have = haveXAU;

  // Gold (XAU) via freegoldapi (daily)
  try {
    const pts = (await fetchFreeGoldApiDaily()).filter(p => p.day >= cutoffDay);
    const rows = [];
    for (const p of pts) {
      if (!have.has(p.day)) {
        rows.push(mkMetalRow('XAU', p.price, p.day));
        have.add(p.day);
      }
    }
    await insertInBatches('metal_price_history', rows);
    added += rows.length;
    console.log(`[metals XAU] ${rows.length} new days (${pts.length} fetched, freegoldapi)`);
  } catch (err) {
    console.log(`[metals XAU] FAILED: ${err.message}`);
  }

  // Platinum (XPT): Metals.Dev, then monthly open dataset — skip Yahoo (saves quota for JSE producers).
  try {
    const md = await seedPlatinumFromMetalsDev(cutoffDay);
    console.log(`[metals XPT] ${md.added} daily rows (Metals.Dev)`);
    return;
  } catch (err) {
    console.log(`[metals XPT] Metals.Dev failed (${err.message}); using monthly platinum.csv`);
  }

  try {
    const pts = (await fetchDatahubPlatinumMonthly()).filter(p => p.day >= cutoffDay);
    const rows = pts.map(p => mkMetalRow('XPT', p.price, p.day));
    await insertInBatches('metal_price_history', rows);
    added += rows.length;
    console.log(`[metals XPT] ${rows.length} months (${pts.length} fetched, datahub)`);
  } catch (e2) {
    console.log(`[metals XPT] FAILED: ${e2.message}`);
  }

  const total = await countRows('metal_price_history', 'asset=eq.XAU');
  console.log(`[metals] done — ${total} gold days in Supabase (${added} new this run)`);
}

async function fetchBinanceKlines(symbol, startTimeMs) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&startTime=${startTimeMs}&limit=1000`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisSeed/1.0)' } });
  if (!res.ok) throw new Error(`Binance ${symbol} HTTP ${res.status}`);
  return res.json();
}

const BINANCE_START_MS = {
  BTC: Date.parse('2017-08-17T00:00:00Z'),
  ETH: Date.parse('2017-08-17T00:00:00Z'),
  CFX: Date.parse('2021-05-01T00:00:00Z'),
};

async function seedCrypto() {
  const BINANCE = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', CFX: 'CFXUSDT' };

  for (const { asset } of CRYPTO) {
    const symbol = BINANCE[asset];
    const have = await getDays('crypto_price_history', `asset=eq.${asset}`);
    const oldestMs = BINANCE_START_MS[asset] || Date.parse('2017-01-01T00:00:00Z');

    console.log(`\n[crypto ${asset}] ${have.size} days stored — fetching all available from Binance (${symbol})...`);
    let cursorMs = oldestMs;
    while (have.has(formatDate(cursorMs))) cursorMs += 86400000;

    let added = 0;
    let pages = 0;
    while (cursorMs < Date.now()) {
      pages++;
      const klines = await fetchBinanceKlines(symbol, cursorMs);
      if (!Array.isArray(klines) || klines.length === 0) break;
      const rows = [];
      for (const k of klines) {
        const openTime = k[0];
        const close = Number(k[4]);
        const day = formatDate(openTime);
        if (!have.has(day) && Number.isFinite(close)) {
          rows.push(mkCryptoRow(asset, close, day));
          have.add(day);
        }
        cursorMs = openTime + 86400000;
      }
      await insertInBatches('crypto_price_history', rows);
      added += rows.length;
      if (klines.length < 1000) break;
      await sleep(250);
    }

    const total = await countRows('crypto_price_history', `asset=eq.${asset}`);
    console.log(`[crypto ${asset}] done — ${total} days (${added} new, ${pages} pages)`);
    await sleep(800);
  }
}

async function seedProducers() {
  const { fetchJseDailyHistory } = await import('../netlify/functions/lib/jse-history.mjs');
  if (!process.env.FMP_API_KEY) {
    console.log('\n[producers] Using Yahoo Finance for JSE (FMP free tier is US-only).');
  }

  const onlyArg = process.argv.find((a) => a.startsWith('--producer='));
  const only = onlyArg ? onlyArg.split('=')[1] : null;
  const tickers = only ? [only] : PRODUCERS;
  const gapArg = process.argv.find((a) => a.startsWith('--producer-gap-ms='));
  const gapMs = gapArg ? Math.max(0, parseInt(gapArg.split('=')[1], 10) || 0) : 60000;

  for (const ticker of tickers) {
    const have = await getDays('producer_price_history', `ticker=eq.${encodeURIComponent(ticker)}`);
    console.log(`\n[producer ${ticker}] ${have.size} days stored — fetching up to 10y (Yahoo → FMP)...`);
    try {
      console.log(`[producer ${ticker}] fetching from Yahoo...`);
      const { points, source } = await fetchJseDailyHistory(ticker, { years: 10 });
      console.log(`[producer ${ticker}] got ${points.length} days (${source}), uploading to Supabase...`);
      const rows = [];
      for (const p of points) {
        if (!have.has(p.day)) rows.push(mkProducerRow(ticker, p.price, p.day));
      }
      await insertInBatches('producer_price_history', rows);
      const total = await countRows('producer_price_history', `ticker=eq.${encodeURIComponent(ticker)}`);
      console.log(`[producer ${ticker}] done — ${total} days (${rows.length} new, source: ${source})`);
    } catch (err) {
      console.log(`[producer ${ticker}] FAILED: ${err.message}`);
    }
    if (gapMs) await sleep(gapMs);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const producersOnly = process.argv.includes('--producers-only');
  console.log('=== Platinum Metis — full Supabase history seed ===');
  if (producersOnly) {
    console.log('Mode: producers only\n');
    await seedProducers();
  } else {
    console.log(`Target: ${BACKFILL_YEARS}y+ metals, all Binance crypto, 10y JSE producers (FMP → Yahoo)\n`);
    await seedProducers();
    await seedMetals();
    await seedCrypto();
  }

  console.log('\n=== Summary ===');
  for (const asset of METALS) {
    const n = await countRows('metal_price_history', `asset=eq.${asset}`);
    console.log(`  ${asset}: ${n} days`);
  }
  for (const { asset } of CRYPTO) {
    const n = await countRows('crypto_price_history', `asset=eq.${asset}`);
    console.log(`  ${asset}: ${n} days`);
  }
  for (const ticker of PRODUCERS) {
    const n = await countRows('producer_price_history', `ticker=eq.${encodeURIComponent(ticker)}`);
    console.log(`  ${ticker}: ${n} days`);
  }
  console.log('\nDone. Charts should now read full curves from Supabase.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
