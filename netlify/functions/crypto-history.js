// netlify/functions/crypto-history.js
//
// READ ONLY — returns whatever is already stored in crypto_price_history.
// Ingestion/backfill is propagate-curves.js.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ASSET_TO_GECKO = { BTC: 'bitcoin', ETH: 'ethereum', CFX: 'conflux-token' };
const GECKO_TO_ASSET = Object.fromEntries(Object.entries(ASSET_TO_GECKO).map(([k, v]) => [v, k]));

export default async (req) => {
  const url = new URL(req.url);
  const requested = url.searchParams.get('id') || url.searchParams.get('symbol');
  const asset = GECKO_TO_ASSET[requested] || requested;

  if (!asset) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing id/symbol parameter' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const histUrl = `${SUPABASE_URL}/rest/v1/crypto_price_history?select=price,recorded_at&asset=eq.${asset}&order=recorded_at.asc&limit=10000`;
    const res = await fetch(histUrl, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ ok: false, error: 'Supabase read failed: ' + res.status }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    const rows = await res.json();
    if (!rows.length) {
      return new Response(JSON.stringify({ ok: false, error: 'No stored history yet for ' + asset }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    const prices = rows.map(r => [new Date(r.recorded_at).getTime(), Number(r.price)]);
    return new Response(JSON.stringify({
      ok: true,
      prices,
      count: prices.length,
      source: 'supabase-crypto_price_history',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
};
