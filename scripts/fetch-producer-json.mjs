#!/usr/bin/env node
/** Fetch JSE producer daily history from Yahoo → data/producer-jse-history.json */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TICKERS = ['VAL.JO', 'IMP.JO', 'SSW.JO', 'NPH.JO'];
const ID_BY_TICKER = {
  'VAL.JO': 'IDX-201',
  'IMP.JO': 'IDX-202',
  'SSW.JO': 'IDX-203',
  'NPH.JO': 'IDX-204',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function zarPrice(close, currency) {
  if (close == null || Number.isNaN(close)) return null;
  if (currency === 'ZAc' || currency === 'GBp') return close / 100;
  return close;
}

async function fetchYahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=10y&interval=1d`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
      Origin: 'https://finance.yahoo.com',
      Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`,
    },
  });
  if (!res.ok) throw new Error(`${ticker} HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`${ticker} no chart`);
  const currency = result.meta?.currency || 'ZAR';
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    const price = zarPrice(closes[i], currency);
    if (price == null) continue;
    const day = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    points.push({ day, price, ts: timestamps[i] * 1000 });
  }
  return { ticker, id: ID_BY_TICKER[ticker], currency, points };
}

async function main() {
  const series = {};
  for (const ticker of TICKERS) {
    console.log(`Fetching ${ticker}...`);
    try {
      const { id, points, currency } = await fetchYahoo(ticker);
      series[id] = { ticker, points, currency };
      console.log(`  ${points.length} days (${currency} → ZAR)`);
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
    }
    await sleep(1500);
  }
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'yahoo-finance',
    series,
  };
  const outPath = path.join(__dirname, '..', 'data', 'producer-jse-history.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
