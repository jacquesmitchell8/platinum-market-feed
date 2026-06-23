// netlify/functions/metals-history.js
//
// Read-mostly — returns whatever is already stored in Supabase.
// Supports `granularity=daily|monthly`. When `monthly`, it will:
// - read from `metal_price_history_monthly` if present
// - otherwise derive month-end closes from daily history and upsert them
//
// Ingestion/backfill of daily data is propagate-curves.js / fetch-market-snapshots.js.

import { sbFetchAll } from './lib/supabase-paginate.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function asISODate(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
}

function monthEndUTC(dateLike) {
  const d = new Date(dateLike);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  // Day 0 of next month = last day of this month
  return new Date(Date.UTC(y, m + 1, 0, 0, 0, 0));
}

function compressToMonthly(rowsAsc) {
  // rowsAsc: [{ recorded_at, price }] asc
  const byMonth = new Map(); // key YYYY-MM -> last row
  for (const r of rowsAsc) {
    const t = new Date(r.recorded_at);
    if (Number.isNaN(t.getTime())) continue;
    const key = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
    byMonth.set(key, r); // last wins as we iterate asc
  }

  const out = [];
  for (const r of byMonth.values()) {
    const me = monthEndUTC(r.recorded_at);
    const recorded_day = asISODate(me);
    out.push({
      recorded_at: me.toISOString(),
      recorded_day,
      price: Number(r.price),
    });
  }

  out.sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
  return out;
}

async function fetchMetalRows(asset, table = 'metal_price_history') {
  return sbFetchAll(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    `${table}?select=price,recorded_at&asset=eq.${encodeURIComponent(asset)}&order=recorded_at.asc`
  );
}

async function sbUpsert(table, rows, onConflict) {
  if (!rows.length) return { ok: true, count: 0 };
  const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) return { ok: false, error: `Supabase upsert failed: ${res.status}` };
  const j = await res.json().catch(() => []);
  return { ok: true, count: Array.isArray(j) ? j.length : rows.length };
}

export default async (req) => {
  const url = new URL(req.url);
  const requested = url.searchParams.get('symbol');
  const symbolMap = { 'GC=F': 'XAU', 'PL=F': 'XPT' };
  const asset = symbolMap[requested] || requested;
  const granularity = (url.searchParams.get('granularity') || 'daily').toLowerCase();

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
    if (granularity === 'monthly') {
      // 1) Try monthly table first
      const mRows = await fetchMetalRows(asset, 'metal_price_history_monthly');
      if (mRows?.length) {
        const prices = mRows.map(r => [new Date(r.recorded_at).getTime(), Number(r.price)]);
        return new Response(JSON.stringify({
          ok: true,
          prices,
          count: prices.length,
          source: 'supabase-metal_price_history_monthly',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      }

      // 2) Derive monthly from daily and upsert
      const dRows = await fetchMetalRows(asset);
      if (!dRows.length) {
        return new Response(JSON.stringify({ ok: false, error: 'No stored history yet for ' + asset }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }

      const monthly = compressToMonthly(dRows).map(r => ({
        asset,
        price: r.price,
        recorded_at: r.recorded_at,
        recorded_day: r.recorded_day,
      }));
      await sbUpsert('metal_price_history_monthly', monthly, 'asset,recorded_day');

      const prices = monthly.map(r => [new Date(r.recorded_at).getTime(), Number(r.price)]);
      return new Response(JSON.stringify({
        ok: true,
        prices,
        count: prices.length,
        source: 'derived-monthly-from-daily',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }

    // daily (default)
    const rows = await fetchMetalRows(asset);
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
