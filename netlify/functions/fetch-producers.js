// netlify/functions/fetch-producers.js
//
// Scheduled function — runs twice daily at 7am and 7pm (see netlify.toml).
// Fetches JSE share prices for the 4 platinum producers via Twelve Data / FMP,
// and upserts into Supabase `producer_quotes`.
//
// Required Netlify env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   TWELVE_DATA_API_KEY  (optional — JSE requires paid Twelve Data plan)
//   FMP_API_KEY          (free — recommended for JSE producer quotes)

import { fetchJseLatestQuote } from './lib/jse-history.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRODUCERS = [
  { ticker: 'VAL.JO', name: 'Valterra Platinum' },
  { ticker: 'IMP.JO', name: 'Impala Platinum' },
  { ticker: 'SSW.JO', name: 'Sibanye-Stillwater' },
  { ticker: 'NPH.JO', name: 'Northam Platinum' },
];

async function fetchQuote(producer) {
  const live = await fetchJseLatestQuote(producer.ticker);
  return {
    ticker: producer.ticker,
    name: producer.name,
    price: live.price,
    currency: live.currency || 'ZAR',
    change_pct: live.change_pct,
    source: live.source,
  };
}

async function upsertQuote(quote) {
  const url = `${SUPABASE_URL}/rest/v1/producer_quotes`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      ticker: quote.ticker,
      name: quote.name,
      price: quote.price,
      currency: quote.currency,
      change_pct: quote.change_pct,
      updated_at: new Date().toISOString(),
      source: quote.source || 'jse-history',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed for ${quote.ticker}: ${res.status} ${text}`);
  }
}

async function appendDailyClose(ticker, price) {
  const day = new Date().toISOString().slice(0, 10);
  await fetch(`${SUPABASE_URL}/rest/v1/producer_price_history?on_conflict=ticker%2Crecorded_day`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      ticker,
      price,
      recorded_at: `${day}T12:00:00Z`,
      recorded_day: day,
    }),
  });
}

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    return new Response('Missing env vars', { status: 500 });
  }

  const results = [];

  for (const producer of PRODUCERS) {
    try {
      const quote = await fetchQuote(producer);
      await upsertQuote(quote);
      await appendDailyClose(producer.ticker, quote.price);
      results.push({ ticker: producer.ticker, ok: true, price: quote.price });
    } catch (err) {
      console.error(err.message);
      results.push({ ticker: producer.ticker, ok: false, error: err.message });
    }
  }

  console.log('Producer fetch run complete:', JSON.stringify(results));

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
