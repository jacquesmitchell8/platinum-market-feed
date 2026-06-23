#!/usr/bin/env node
/**
 * ONE-OFF full history seed for Supabase.
 *
 * Setup (once):
 *   1. Copy .env.seed.example → .env.seed
 *   2. Paste real values from Netlify → Environment variables
 *   3. node scripts/seed-supabase-history.js
 *
 * Or after git push, hit /.netlify/functions/seed-history on your live site
 * (uses Netlify env vars automatically — no local keys needed).
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
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const METALS_DEV_API_KEY = process.env.METALS_DEV_API_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

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
  Open https://platinum-conflux.netlify.app/.netlify/functions/seed-history
  Repeat until the response says "complete": true`);
}

if (SUPABASE_URL.includes('your-url') || SUPABASE_SERVICE_ROLE_KEY.includes('your-key')) {
  die('Still using placeholder values in .env.seed — paste your real Netlify env vars.');
}

if (!SUPABASE_URL.startsWith('https://') || !SUPABASE_URL.includes('supabase.co')) {
  die(`SUPABASE_URL looks wrong: ${SUPABASE_URL}`);
}

if (!METALS_DEV_API_KEY) {
  die('METALS_DEV_API_KEY is required — copy it from Netlify environment variables.');
}

const BACKFILL_YEARS = 10;
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

async function countRows(table, filter) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=recorded_day&${filter}`;
  const res = await fetch(url, { headers: { ...sbHeaders(), Prefer: 'count=exact', Range: '0-0' } });
  const range = res.headers.get('content-range') || '';
  const m = range.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

async function getDays(table, filter) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=recorded_day&${filter}&order=recorded_day.asc&limit=10000`;
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) return new Set();
  const rows = await res.json();
  return new Set(rows.map((r) => r.recorded_day));
}

async function upsertMetal(asset, price, dateStr) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/metal_price_history`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates' }),
    body: JSON.stringify({ asset, price, recorded_at: `${dateStr}T12:00:00Z`, recorded_day: dateStr }),
  });
  return res.ok;
}

async function upsertCrypto(asset, price, dateStr) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/crypto_price_history`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates' }),
    body: JSON.stringify({ asset, price, recorded_at: `${dateStr}T12:00:00Z`, recorded_day: dateStr }),
  });
  return res.ok;
}

async function upsertProducer(ticker, price, dateStr) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/producer_price_history`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates' }),
    body: JSON.stringify({ ticker, price, recorded_at: `${dateStr}T12:00:00Z`, recorded_day: dateStr }),
  });
  return res.ok;
}

async function fetchMetalsChunk(start, end) {
  if (!METALS_DEV_API_KEY) throw new Error('METALS_DEV_API_KEY not set');
  const startStr = formatDate(start);
  const endStr = formatDate(end);
  if (startStr > endStr) return {};
  const url = `https://api.metals.dev/v1/timeseries?api_key=${METALS_DEV_API_KEY}&start_date=${startStr}&end_date=${endStr}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Metals.Dev HTTP ${res.status}: ${data.error_message || ''}`);
  if (data.status !== 'success') throw new Error(data.error_message || 'Metals.Dev error');
  return data.rates || {};
}

async function seedMetals() {
  const latest = metalsDevLatest();
  const oldest = new Date();
  oldest.setFullYear(oldest.getFullYear() - BACKFILL_YEARS);
  oldest.setUTCHours(0, 0, 0, 0);

  const have = await getDays('metal_price_history', 'asset=eq.XAU');
  let cursor = new Date(oldest);
  while (cursor <= latest && have.has(formatDate(cursor))) cursor.setUTCDate(cursor.getUTCDate() + 1);

  let chunks = 0;
  let added = 0;

  console.log(`\n[metals] ${have.size} days stored — seeding from ${formatDate(cursor)} to ${formatDate(latest)} (today via snapshots)`);

  while (cursor <= latest) {
    let chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_DAYS - 1);
    if (chunkEnd > latest) chunkEnd = new Date(latest);

    process.stdout.write(`  chunk ${++chunks}: ${formatDate(cursor)} → ${formatDate(chunkEnd)} ... `);
    try {
      const rates = await fetchMetalsChunk(cursor, chunkEnd);
      let n = 0;
      for (const [dateStr, dayData] of Object.entries(rates)) {
        if (dayData?.metals?.gold != null) { await upsertMetal('XAU', dayData.metals.gold, dateStr); have.add(dateStr); n++; added++; }
        if (dayData?.metals?.platinum != null) { await upsertMetal('XPT', dayData.metals.platinum, dateStr); added++; }
      }
      console.log(`${n} days`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }

    cursor.setUTCDate(cursor.getUTCDate() + CHUNK_DAYS);
  }

  const total = await countRows('metal_price_history', 'asset=eq.XAU');
  console.log(`[metals] done — ${total} gold days in Supabase (${added} new this run)`);
}

function cgUrl(path) {
  const base = `https://api.coingecko.com/api/v3/${path}`;
  if (!COINGECKO_API_KEY) return base;
  return `${base}${base.includes('?') ? '&' : '?'}x_cg_demo_api_key=${COINGECKO_API_KEY}`;
}

async function seedCrypto() {
  const today = new Date();
  const oldest = new Date();
  oldest.setFullYear(oldest.getFullYear() - 5);

  for (const { asset, geckoId } of CRYPTO) {
    const have = await getDays('crypto_price_history', `asset=eq.${asset}`);
    const target = Math.ceil((today - oldest) / 86400000);
    if (have.size >= target - 7) {
      console.log(`\n[crypto ${asset}] already complete (${have.size} days)`);
      continue;
    }

    console.log(`\n[crypto ${asset}] fetching ${target} days from CoinGecko...`);
    const res = await fetch(cgUrl(`coins/${geckoId}/market_chart?vs_currency=usd&days=${Math.min(target, 1825)}`), {
      headers: { 'User-Agent': 'PlatinumMetisSeed/1.0' },
    });
    if (!res.ok) throw new Error(`CoinGecko ${asset} HTTP ${res.status}`);
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
    const total = await countRows('crypto_price_history', `asset=eq.${asset}`);
    console.log(`[crypto ${asset}] done — ${total} days (${added} new)`);
    await sleep(1500);
  }
}

async function fetchYahoo(ticker, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'PlatinumMetisSeed/1.0' } });
  if (!res.ok) throw new Error(`Yahoo ${ticker} HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${ticker} no data`);
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    points.push({ day: formatDate(timestamps[i] * 1000), price: closes[i] });
  }
  return points;
}

async function seedProducers() {
  for (const ticker of PRODUCERS) {
    const have = await getDays('producer_price_history', `ticker=eq.${encodeURIComponent(ticker)}`);
    console.log(`\n[producer ${ticker}] ${have.size} days stored — fetching 2y from Yahoo...`);
    try {
      const points = await fetchYahoo(ticker, '2y');
      let added = 0;
      for (const p of points) {
        if (!have.has(p.day)) { await upsertProducer(ticker, p.price, p.day); added++; }
      }
      const total = await countRows('producer_price_history', `ticker=eq.${encodeURIComponent(ticker)}`);
      console.log(`[producer ${ticker}] done — ${total} days (${added} new)`);
    } catch (err) {
      console.log(`[producer ${ticker}] FAILED: ${err.message}`);
    }
    await sleep(800);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Platinum Metis — full Supabase history seed ===');
  console.log(`Target: ${BACKFILL_YEARS}y metals, 5y crypto, 2y producers\n`);

  await seedMetals();
  await seedCrypto();
  await seedProducers();

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
