// netlify/functions/metals-history.js
//
// Returns gold/platinum price HISTORY built entirely from our own data —
// every snapshot fetch-market-snapshots.js has written to Supabase
// `market_snapshots` since this system went live (every 5 min). No
// third-party historical API involved at all: not Yahoo (blocked by bot
// detection), not gold-api.com's unclear-pricing history tier, nothing
// external for history specifically.
//
// This will look thin on day one and get genuinely useful over the
// following days/weeks as more snapshots accumulate — which is the
// correct trade-off for a system that should never again depend on a
// fragile or gated third-party historical endpoint for something this
// data already collects for free, just by running.
//
// Matches the same { ok, prices: [[ts_ms, price], ...] } shape the
// dashboard's fetchMetalProxy() already expects, so no caller-side changes
// needed beyond pointing the URL here.
//
// Required Netlify env vars:
//   SUPABASE_URL      -> <your Supabase project URL>
//   SUPABASE_ANON_KEY -> publishable/anon key (read-only, safe to use here)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// We only ever store the LATEST snapshot per asset in market_snapshots
// (it's an upsert table, not an append log) — so true history requires a
// separate append-only table. This function checks for one and creates the
// shape gracefully degrades to "just the current point" if it doesn't
// exist yet, rather than erroring outright.
const HISTORY_TABLE = 'metal_price_history';

export default async (req) => {
  const url = new URL(req.url);
  const symbol = url.searchParams.get('symbol'); // 'XAU' or 'XPT' (also accepts GC=F/PL=F for compatibility)
  const symbolMap = { 'GC=F': 'XAU', 'PL=F': 'XPT' };
  const key = symbolMap[symbol] || symbol;

  if (!key) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing symbol parameter' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const histUrl = `${SUPABASE_URL}/rest/v1/${HISTORY_TABLE}?select=price,recorded_at&asset=eq.${encodeURIComponent(key)}&order=recorded_at.asc&limit=5000`;
    const histRes = await fetch(histUrl, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });

    if (histRes.ok) {
      const rows = await histRes.json();
      if (Array.isArray(rows) && rows.length > 0) {
        const prices = rows.map(r => [new Date(r.recorded_at).getTime(), r.price]);
        return new Response(JSON.stringify({ ok: true, prices, source: 'supabase-history' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    // Table missing or empty (404 from PostgREST if table doesn't exist, or just no rows yet) —
    // fall through to returning just the current snapshot below, rather than erroring.
  } catch (_) {
    // Same fallback applies on any unexpected failure reading history.
  }

  try {
    const snapUrl = `${SUPABASE_URL}/rest/v1/market_snapshots?select=payload,updated_at&snapshot_key=eq.${encodeURIComponent(key)}`;
    const snapRes = await fetch(snapUrl, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!snapRes.ok) throw new Error(`Supabase snapshot fetch failed: ${snapRes.status}`);
    const rows = await snapRes.json();
    if (!rows.length) throw new Error('No snapshot data yet for ' + key);

    const row = rows[0];
    const prices = [[new Date(row.updated_at).getTime(), row.payload.price]];

    return new Response(JSON.stringify({
      ok: true,
      prices,
      source: 'supabase-snapshot-only',
      warn: 'History table not yet available — showing current snapshot only. History accumulates daily.',
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
