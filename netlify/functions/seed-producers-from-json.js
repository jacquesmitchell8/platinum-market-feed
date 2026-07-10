// One-shot: bulk-insert all JSE producer daily history from data/producer-jse-history.json.
// Runs on deploy when tables are empty — no Yahoo required.

import { sbCount } from './lib/supabase-paginate.js';
import {
  TICKERS,
  loadProducerHistoryJson,
  pointsToRows,
  staticPointsForTicker,
} from './lib/producer-json-seed.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BATCH_SIZE = 500;

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function insertBatch(rows) {
  if (!rows.length) return;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/producer_price_history?on_conflict=ticker%2Crecorded_day`,
    {
      method: 'POST',
      headers: sbHeaders({
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      }),
      body: JSON.stringify(rows),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase batch insert HTTP ${res.status}${text ? ': ' + text.slice(0, 120) : ''}`);
  }
}

async function historyCount(ticker) {
  return sbCount(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    'producer_price_history',
    `ticker=eq.${encodeURIComponent(ticker)}`
  );
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response('Missing env vars', { status: 500 });
  }

  const counts = await Promise.all(TICKERS.map(async (ticker) => ({ ticker, count: await historyCount(ticker) })));
  const total = counts.reduce((n, c) => n + c.count, 0);
  if (total >= 2000) {
    return new Response(
      JSON.stringify({ ok: true, skipped: true, reason: 'already seeded', counts }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const data = await loadProducerHistoryJson();
  const results = [];

  for (const ticker of TICKERS) {
    const points = staticPointsForTicker(data, ticker);
    if (!points.length) {
      results.push({ ticker, error: 'no static points' });
      continue;
    }
    const rows = pointsToRows(ticker, points);
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      await insertBatch(rows.slice(i, i + BATCH_SIZE));
    }
    const after = await historyCount(ticker);
    results.push({ ticker, inserted: rows.length, total: after, source: 'producer-jse-history.json' });
  }

  console.log('seed-producers-from-json:', JSON.stringify(results));
  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
