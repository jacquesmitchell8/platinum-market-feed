// netlify/functions/propagate-producers.js
//
// Scheduled ingestion — one JSE producer per run, batched upsert into Supabase.
// Avoids Yahoo 429 from backfilling all four tickers on every page load.

import { sbCount } from './lib/supabase-paginate.js';
import { fetchJseDailyHistory } from './lib/jse-history.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRODUCERS = ['VAL.JO', 'IMP.JO', 'SSW.JO', 'NPH.JO'];
const BATCH_SIZE = 500;

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function historyCount(ticker) {
  return sbCount(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    'producer_price_history',
    `ticker=eq.${encodeURIComponent(ticker)}`
  );
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

async function backfillTicker(ticker) {
  const have = await historyCount(ticker);
  const years = have < 200 ? 10 : 1;
  const { points, source } = await fetchJseDailyHistory(ticker, { years });
  const rows = points.map((p) => ({
    ticker,
    price: p.price,
    recorded_at: `${p.day}T12:00:00Z`,
    recorded_day: p.day,
  }));
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await insertBatch(rows.slice(i, i + BATCH_SIZE));
  }
  const total = await historyCount(ticker);
  return { ticker, source, added: rows.length, total, had: have };
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response('Missing env vars', { status: 500 });
  }

  // Pick the ticker with the least history (or rotate by hour)
  const counts = await Promise.all(PRODUCERS.map(async (t) => ({ ticker: t, count: await historyCount(t) })));
  counts.sort((a, b) => a.count - b.count);
  const hourSlot = new Date().getUTCHours() % PRODUCERS.length;
  const target = counts[0].count < 100 ? counts[0].ticker : PRODUCERS[hourSlot];

  try {
    const result = await backfillTicker(target);
    console.log('propagate-producers:', JSON.stringify(result));
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(`propagate-producers ${target}:`, err.message);
    return new Response(JSON.stringify({ ok: false, ticker: target, error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
