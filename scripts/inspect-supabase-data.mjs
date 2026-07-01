#!/usr/bin/env node
/** Inspect Supabase metal/crypto/producer history — date ranges, gaps, recent rows. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sbFetchAll } from '../netlify/functions/lib/supabase-paginate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env.seed');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq < 1) continue;
  process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function fetchMetal(asset) {
  return sbFetchAll(
    URL,
    KEY,
    `metal_price_history?select=price,recorded_at,recorded_day&asset=eq.${encodeURIComponent(asset)}&order=recorded_day.asc`
  );
}

async function fetchMonthly(asset) {
  return sbFetchAll(
    URL,
    KEY,
    `metal_price_history_monthly?select=price,recorded_at,recorded_day&asset=eq.${encodeURIComponent(asset)}&order=recorded_day.asc`
  );
}

async function fetchCrypto(asset) {
  return sbFetchAll(
    URL,
    KEY,
    `crypto_price_history?select=price,recorded_at,recorded_day&asset=eq.${encodeURIComponent(asset)}&order=recorded_day.asc`
  );
}

async function fetchProducer(ticker) {
  return sbFetchAll(
    URL,
    KEY,
    `producer_price_history?select=price,recorded_at,recorded_day,ticker&order=recorded_day.asc&ticker=eq.${encodeURIComponent(ticker)}`
  );
}

function summarize(label, rows) {
  if (!rows.length) {
    console.log(`\n=== ${label} === EMPTY`);
    return;
  }
  const days = rows.map((r) => r.recorded_day || String(r.recorded_at).slice(0, 10)).sort();
  const first = days[0];
  const last = days[days.length - 1];
  const today = new Date().toISOString().slice(0, 10);
  const gapDays = Math.round((Date.parse(today) - Date.parse(last)) / 86400000);
  const prices = rows.map((r) => Number(r.price)).filter((p) => !Number.isNaN(p));
  console.log(`\n=== ${label} ===`);
  console.log(`  rows: ${rows.length}`);
  console.log(`  range: ${first} → ${last}`);
  console.log(`  gap from today: ${gapDays} days`);
  console.log(`  last price: ${rows[rows.length - 1].price} (${last})`);
  console.log(`  min/max: ${Math.min(...prices).toFixed(2)} / ${Math.max(...prices).toFixed(2)}`);
  console.log('  last 5 days:');
  for (const r of rows.slice(-5)) {
    const d = r.recorded_day || String(r.recorded_at).slice(0, 10);
    console.log(`    ${d}  ${r.price}`);
  }
}

async function main() {
  console.log('Supabase:', URL);
  console.log('Today UTC:', new Date().toISOString().slice(0, 10));

  const xau = await fetchMetal('XAU');
  const xpt = await fetchMetal('XPT');
  const xauM = await fetchMonthly('XAU');
  const xptM = await fetchMonthly('XPT');

  summarize('XAU daily', xau);
  summarize('XPT daily', xpt);
  summarize('XAU monthly (cached table)', xauM);
  summarize('XPT monthly (cached table)', xptM);

  const today = new Date().toISOString().slice(0, 10);
  const missingXau = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    if (!xau.find((r) => (r.recorded_day || String(r.recorded_at).slice(0, 10)) === day)) {
      missingXau.push(day);
    }
  }
  console.log('\n=== XAU missing in last 30 days ===');
  console.log(missingXau.length ? missingXau.join(', ') : 'none — all present');

  if (xauM.length && xau.length) {
    const dailyLast = xau[xau.length - 1];
    const monthlyLast = xauM[xauM.length - 1];
    console.log('\n=== Monthly vs daily freshness (XAU) ===');
    console.log(`  daily last: ${dailyLast.recorded_day} @ ${dailyLast.price}`);
    console.log(`  monthly table last: ${monthlyLast.recorded_day} @ ${monthlyLast.price}`);
    if (Number(monthlyLast.price) !== Number(dailyLast.price) && monthlyLast.recorded_day?.startsWith(dailyLast.recorded_day?.slice(0, 7))) {
      console.log('  ⚠ monthly table price lags current month daily close');
    }
  }

  for (const asset of ['BTC', 'ETH', 'CFX']) {
    summarize(`crypto ${asset}`, await fetchCrypto(asset));
  }

  for (const ticker of ['VAL.JO', 'IMP.JO', 'SSW.JO', 'NPH.JO']) {
    summarize(`producer ${ticker}`, await fetchProducer(ticker));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
