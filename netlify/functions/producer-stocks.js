// netlify/functions/producer-stocks.js
//
// Called by the dashboard's Producers tab on every page load.
// On each call: fetches fresh JSE share prices via Yahoo Finance for the 4
// platinum producers, upserts into Supabase `producer_quotes` (running
// historical record), then returns the latest quotes in the shape the
// dashboard expects.
//
// The separate fetch-producers.js scheduled function (7am/7pm) still runs
// as a backup cadence in case the page isn't visited for a while.
//
// Required Netlify env vars:
//   SUPABASE_URL              -> <your Supabase project URL>
//   SUPABASE_SERVICE_ROLE_KEY -> secret key (needed here because this function writes, not just reads)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRODUCERS = [
  { ticker: 'VAL.JO', name: 'Valterra Platinum', id: 'IDX-201', country: 'South Africa', production: '~1.7 Moz Pt/yr' },
  { ticker: 'IMP.JO', name: 'Impala Platinum', id: 'IDX-202', country: 'South Africa', production: '~1.1 Moz Pt/yr' },
  { ticker: 'SSW.JO', name: 'Sibanye-Stillwater', id: 'IDX-203', country: 'South Africa / USA', production: '~0.9 Moz Pt/yr' },
  { ticker: 'NPH.JO', name: 'Northam Platinum', id: 'IDX-204', country: 'South Africa', production: '~0.5 Moz Pt/yr' },
];

async function fetchQuote(producer) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${producer.ticker}?range=5d&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/1.0)' }
  });
  if (!res.ok) throw new Error(`${producer.ticker} fetch failed: ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`${producer.ticker} no chart result`);

  const closes = (result.indicators?.quote?.[0]?.close || []).filter(c => c != null);
  const latest = closes[closes.length - 1];
  const prior = closes[closes.length - 2];
  if (latest == null) throw new Error(`${producer.ticker} no valid close price`);

  return {
    ticker: producer.ticker,
    name: producer.name,
    price: latest,
    currency: result.meta?.currency || 'ZAR',
    change_pct: prior ? ((latest - prior) / prior) * 100 : null,
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
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      ticker: quote.ticker, name: quote.name, price: quote.price, currency: quote.currency,
      change_pct: quote.change_pct, updated_at: new Date().toISOString(), source: 'yahoo-finance',
    })
  });
  return res.ok;
}

async function refreshProducersFromYahoo() {
  const fresh = {};
  for (const producer of PRODUCERS) {
    try {
      const quote = await fetchQuote(producer);
      await upsertQuote(quote);
      fresh[quote.ticker] = quote;
    } catch (err) {
      console.error(`Producer refresh failed for ${producer.ticker}: ${err.message}`);
    }
  }
  return fresh;
}

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let freshQuotes = {};
  try {
    freshQuotes = await refreshProducersFromYahoo();
  } catch (err) {
    console.error('refreshProducersFromYahoo failed entirely: ' + err.message);
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/producer_quotes?select=ticker,name,price,currency,change_pct,updated_at,source`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
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

    const oldestUpdate = rows.length
      ? rows.reduce((min, r) => Math.min(min, new Date(r.updated_at).getTime()), Date.now())
      : Date.now();

    return new Response(JSON.stringify({
      ok: true,
      quotes,
      announcements: [],
      updatedAt: new Date(oldestUpdate).toISOString(),
      stale: Object.keys(freshQuotes).length === 0, // true only if this call's live refresh failed entirely
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
