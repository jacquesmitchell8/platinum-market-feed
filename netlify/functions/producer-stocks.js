// netlify/functions/producer-stocks.js
//
// Called by the dashboard's Producers tab on every page load.
// On each call:
//   1. Fetches JSE share prices via Twelve Data (or FMP fallback)
//   2. Appends daily closes into producer_price_history (our own curve record)
//   3. Gap-fills from the data provider if history is thin
//   4. Returns chart rows + producerMeta in the shape the dashboard expects
//
// Required Netlify env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   TWELVE_DATA_API_KEY  (free — https://twelvedata.com/pricing)

import { sbFetchAll } from './lib/supabase-paginate.js';
import { fetchJseDailyHistory, fetchJseLatestQuote } from './lib/jse-history.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRODUCERS = [
  { ticker: 'VAL.JO', name: 'Valterra Platinum', id: 'IDX-201', country: 'South Africa', production: '~1.7 Moz Pt/yr' },
  { ticker: 'IMP.JO', name: 'Impala Platinum', id: 'IDX-202', country: 'South Africa', production: '~1.1 Moz Pt/yr' },
  { ticker: 'SSW.JO', name: 'Sibanye-Stillwater', id: 'IDX-203', country: 'South Africa / USA', production: '~0.9 Moz Pt/yr' },
  { ticker: 'NPH.JO', name: 'Northam Platinum', id: 'IDX-204', country: 'South Africa', production: '~0.5 Moz Pt/yr' },
];

const TICKER_TO_ID = Object.fromEntries(PRODUCERS.map(p => [p.ticker, p.id]));

const TIMEFRAME_FILTERS = {
  '24h': { hours: 24 },
  '1w': { days: 7 },
  '1m': { days: 30 },
  '3m': { days: 90 },
  '1y': { days: 365 },
  '3y': { days: 1095 },
  '5y': { days: 1825 },
};

function formatDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function supabaseHeaders() {
  return { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
}

async function getStoredHistory(ticker) {
  return sbFetchAll(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    `producer_price_history?select=price,recorded_at&ticker=eq.${encodeURIComponent(ticker)}&order=recorded_at.asc`
  );
}

async function upsertHistoryRow(ticker, price, dateStr) {
  await fetch(`${SUPABASE_URL}/rest/v1/producer_price_history`, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates'
    },
    body: JSON.stringify({ ticker, price, recorded_at: `${dateStr}T12:00:00Z`, recorded_day: dateStr })
  });
}

async function storePoints(ticker, points) {
  for (const p of points) {
    await upsertHistoryRow(ticker, p.price, p.day);
  }
}

async function ensureHistory(producer) {
  const stored = await getStoredHistory(producer.ticker);
  const today = new Date();
  const oldestWanted = new Date();
  oldestWanted.setFullYear(oldestWanted.getFullYear() - 2);

  const lastStored = stored.length ? new Date(stored[stored.length - 1].recorded_at) : null;
  const needsBackfill = !stored.length || (lastStored && lastStored < oldestWanted);

  let freshPoints = [];
  try {
    const years = needsBackfill ? 10 : 1;
    const { points, source } = await fetchJseDailyHistory(producer.ticker, { years });
    freshPoints = points;
    await storePoints(producer.ticker, freshPoints);
    console.log(`[producer ${producer.ticker}] ${points.length} days from ${source}`);
  } catch (err) {
    console.error(`Producer fetch failed for ${producer.ticker}: ${err.message}`);
  }

  const updated = await getStoredHistory(producer.ticker);
  return { stored: updated, freshPoints };
}

async function upsertQuote(quote) {
  const url = `${SUPABASE_URL}/rest/v1/producer_quotes`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      ticker: quote.ticker, name: quote.name, price: quote.price, currency: quote.currency,
      change_pct: quote.change_pct, updated_at: new Date().toISOString(), source: quote.source || 'jse-history',
    })
  });
  return res.ok;
}

function filterByTimeframe(points, timeframeId) {
  const tf = TIMEFRAME_FILTERS[timeframeId];
  if (!tf || !points.length) return points;
  const now = Date.now();
  if (tf.hours) return points.filter(p => now - p.ts <= tf.hours * 3600000);
  if (tf.days) return points.filter(p => now - p.ts <= tf.days * 86400000);
  return points;
}

function buildChartRows(seriesMap, timeframeId) {
  const tsSet = new Set();
  Object.values(seriesMap).forEach(pts => pts.forEach(p => tsSet.add(p.ts)));
  const sorted = [...tsSet].sort((a, b) => a - b);
  return sorted.map(ts => {
    const row = { ts };
    Object.entries(seriesMap).forEach(([id, pts]) => {
      const hit = pts.find(p => p.ts === ts);
      if (hit) row[id] = hit.price;
      else {
        const prior = [...pts].filter(p => p.ts <= ts).pop();
        if (prior) row[id] = prior.price;
      }
    });
    return row;
  });
}

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(req.url);
  const timeframeId = url.searchParams.get('timeframe') || '1y';

  const seriesMap = {};
  const freshQuotes = {};

  for (const producer of PRODUCERS) {
    const { stored, freshPoints } = await ensureHistory(producer);
    const points = stored.map(r => ({
      ts: new Date(r.recorded_at).getTime(),
      price: r.price,
    }));
    const filtered = filterByTimeframe(points, timeframeId);
    if (filtered.length) seriesMap[producer.id] = filtered;

    const latest = freshPoints.length ? freshPoints[freshPoints.length - 1] : points[points.length - 1];
    const prior = freshPoints.length > 1 ? freshPoints[freshPoints.length - 2] : points[points.length - 2];
    if (latest) {
      let quote = {
        ticker: producer.ticker,
        name: producer.name,
        price: latest.price,
        currency: 'ZAR',
        change_pct: prior ? ((latest.price - prior.price) / prior.price) * 100 : null,
        source: 'jse-history',
      };
      try {
        const live = await fetchJseLatestQuote(producer.ticker);
        quote = {
          ...quote,
          price: live.price,
          currency: live.currency || 'ZAR',
          change_pct: live.change_pct ?? quote.change_pct,
          source: live.source,
        };
      } catch (_) { /* use last stored close */ }
      await upsertQuote(quote);
      freshQuotes[producer.ticker] = quote;
    }
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/producer_quotes?select=ticker,name,price,currency,change_pct,updated_at,source`, {
      headers: supabaseHeaders()
    });
    if (!res.ok) throw new Error(`Supabase read failed: ${res.status}`);
    const rows = await res.json();

    const meta = Object.fromEntries(PRODUCERS.map(p => [p.ticker, p]));
    const quotes = rows.map((r) => {
      const m = meta[r.ticker] || {};
      return {
        id: m.id,
        company: m.name,
        country: m.country,
        production: m.production,
        ticker: r.ticker,
        exchange: 'JSE',
        priceZar: r.currency === 'ZAR' ? r.price : null,
        changePct: r.change_pct,
        updatedAt: r.updated_at,
      };
    });

    const chartRows = buildChartRows(seriesMap, timeframeId);
    const oldestUpdate = rows.length
      ? rows.reduce((min, r) => Math.min(min, new Date(r.updated_at).getTime()), Date.now())
      : Date.now();

    return new Response(JSON.stringify({
      ok: true,
      rows: chartRows,
      producerMeta: { quotes, announcements: [] },
      updatedAt: new Date(oldestUpdate).toISOString(),
      stale: Object.keys(freshQuotes).length === 0,
      source: 'self-filling-producer-history',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
};
