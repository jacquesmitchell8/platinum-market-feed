// netlify/functions/producer-stocks.js
//
// READ-ONLY API for the Producers tab — loads chart curves from Supabase.
// History is seeded by propagate-producers (scheduled) or scripts/seed-supabase-history.js.
// Live quotes come from producer_quotes (fetch-producers scheduled job).

import { sbFetchAll } from './lib/supabase-paginate.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRODUCERS = [
  { ticker: 'VAL.JO', name: 'Valterra Platinum', id: 'IDX-201', country: 'South Africa', production: '~1.7 Moz Pt/yr', marketSharePct: 29 },
  { ticker: 'IMP.JO', name: 'Impala Platinum', id: 'IDX-202', country: 'South Africa', production: '~1.1 Moz Pt/yr', marketSharePct: 19 },
  { ticker: 'SSW.JO', name: 'Sibanye-Stillwater', id: 'IDX-203', country: 'South Africa / USA', production: '~0.9 Moz Pt/yr', marketSharePct: 16 },
  { ticker: 'NPH.JO', name: 'Northam Platinum', id: 'IDX-204', country: 'South Africa', production: '~0.5 Moz Pt/yr', marketSharePct: 9 },
];

const TIMEFRAME_FILTERS = {
  '24h': { hours: 24 },
  '1w': { days: 7 },
  '1m': { days: 30 },
  '3m': { days: 90 },
  '1y': { days: 365 },
  '3y': { days: 1095 },
  '5y': { days: 1825 },
};

function supabaseHeaders() {
  return { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` };
}

function filterByTimeframe(points, timeframeId) {
  const tf = TIMEFRAME_FILTERS[timeframeId];
  if (!tf || !points.length) return points;
  const now = Date.now();
  if (tf.hours) return points.filter((p) => now - p.ts <= tf.hours * 3600000);
  if (tf.days) return points.filter((p) => now - p.ts <= tf.days * 86400000);
  return points;
}

function buildChartRows(seriesMap, timeframeId) {
  const tsSet = new Set();
  Object.values(seriesMap).forEach((pts) => pts.forEach((p) => tsSet.add(p.ts)));
  const sorted = [...tsSet].sort((a, b) => a - b);
  return sorted.map((ts) => {
    const row = { ts };
    Object.entries(seriesMap).forEach(([id, pts]) => {
      const hit = pts.find((p) => p.ts === ts);
      if (hit) row[id] = hit.price;
      else {
        const prior = [...pts].filter((p) => p.ts <= ts).pop();
        if (prior) row[id] = prior.price;
      }
    });
    return row;
  });
}

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const timeframeId = url.searchParams.get('timeframe') || '1y';

  try {
    const [historyRows, quoteRows] = await Promise.all([
      sbFetchAll(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        'producer_price_history?select=ticker,price,recorded_at&order=recorded_at.asc'
      ),
      fetch(`${SUPABASE_URL}/rest/v1/producer_quotes?select=ticker,name,price,currency,change_pct,updated_at,source`, {
        headers: supabaseHeaders(),
      }).then((r) => (r.ok ? r.json() : [])),
    ]);

    const byTicker = {};
    for (const r of historyRows) {
      if (!byTicker[r.ticker]) byTicker[r.ticker] = [];
      byTicker[r.ticker].push({
        ts: new Date(r.recorded_at).getTime(),
        price: Number(r.price),
      });
    }

    const seriesMap = {};
    const historyCounts = {};
    for (const producer of PRODUCERS) {
      const points = byTicker[producer.ticker] || [];
      historyCounts[producer.ticker] = points.length;
      const filtered = filterByTimeframe(points, timeframeId);
      if (filtered.length) seriesMap[producer.id] = filtered;
    }

    const meta = Object.fromEntries(PRODUCERS.map((p) => [p.ticker, p]));
    const quotes = (quoteRows || []).map((r) => {
      const m = meta[r.ticker] || {};
      return {
        id: m.id,
        company: m.name,
        country: m.country,
        production: m.production,
        marketSharePct: m.marketSharePct,
        ticker: r.ticker,
        exchange: 'JSE',
        priceZar: r.currency === 'ZAR' ? r.price : null,
        changePct: r.change_pct,
        updatedAt: r.updated_at,
      };
    });

    const chartRows = buildChartRows(seriesMap, timeframeId);
    const missingHistory = PRODUCERS.filter((p) => !historyCounts[p.ticker]).map((p) => p.ticker);
    const thinHistory = PRODUCERS.filter((p) => historyCounts[p.ticker] > 0 && historyCounts[p.ticker] < 30)
      .map((p) => p.ticker);

    const oldestUpdate = quoteRows?.length
      ? quoteRows.reduce((min, r) => Math.min(min, new Date(r.updated_at).getTime()), Date.now())
      : Date.now();

    let warn = null;
    if (missingHistory.length) {
      warn = `No history in Supabase for ${missingHistory.join(', ')} — scheduled backfill in progress.`;
    } else if (thinHistory.length) {
      warn = `Thin history for ${thinHistory.join(', ')} — more days loading on schedule.`;
    }

    return new Response(JSON.stringify({
      ok: true,
      rows: chartRows,
      producerMeta: { quotes, announcements: [], historyCounts },
      updatedAt: new Date(oldestUpdate).toISOString(),
      stale: !quoteRows?.length,
      warn,
      source: 'supabase-producer-history',
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120, stale-while-revalidate=300',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
};
