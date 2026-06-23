// netlify/functions/metals-history.js
//
// READ ONLY — returns whatever is already stored in metal_price_history.
// Charts call this; it must be fast. Ingestion/backfill is propagate-curves.js.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async (req) => {
  const url = new URL(req.url);
  const requested = url.searchParams.get('symbol');
  const symbolMap = { 'GC=F': 'XAU', 'PL=F': 'XPT' };
  const asset = symbolMap[requested] || requested;

  if (!asset) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing symbol parameter' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const histUrl = `${SUPABASE_URL}/rest/v1/metal_price_history?select=price,recorded_at&asset=eq.${asset}&order=recorded_at.asc&limit=10000`;
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
      source: 'supabase-metal_price_history',
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
