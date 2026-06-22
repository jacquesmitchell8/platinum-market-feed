// netlify/functions/fetch-producers.js
//
// Scheduled function — runs twice daily at 7am and 7pm (see netlify.toml).
// Fetches JSE share prices for the 4 platinum producers via Yahoo Finance's
// unofficial v8 chart endpoint, and upserts into Supabase `producer_quotes`.
//
// Required Netlify env vars:
//   SUPABASE_URL              -> https://tjxiaidxcwpvsnwfvdck.supabase.co (market-feed project)
//   SUPABASE_SERVICE_ROLE_KEY -> secret key (NEVER the anon/publishable key, NEVER exposed to browser)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRODUCERS = [
  { ticker: 'VAL.JO', name: 'Valterra Platinum' },
  { ticker: 'IMP.JO', name: 'Impala Platinum' },
  { ticker: 'SSW.JO', name: 'Sibanye-Stillwater' },
  { ticker: 'NPH.JO', name: 'Northam Platinum' },
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

  const closes = result.indicators?.quote?.[0]?.close || [];
  const validCloses = closes.filter(c => c != null);
  const latest = validCloses[validCloses.length - 1];
  const prior = validCloses[validCloses.length - 2];

  if (latest == null) throw new Error(`${producer.ticker} no valid close price`);

  const changePct = prior ? ((latest - prior) / prior) * 100 : null;
  const currency = result.meta?.currency || 'ZAR';

  return {
    ticker: producer.ticker,
    name: producer.name,
    price: latest,
    currency,
    change_pct: changePct,
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
      ticker: quote.ticker,
      name: quote.name,
      price: quote.price,
      currency: quote.currency,
      change_pct: quote.change_pct,
      updated_at: new Date().toISOString(),
      source: 'yahoo-finance',
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed for ${quote.ticker}: ${res.status} ${text}`);
  }
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
