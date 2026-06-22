// netlify/functions/producer-stocks.js
//
// On-demand function (not scheduled) — called by the dashboard page whenever
// the "Producers" tab loads. Reads the latest quotes written by the
// fetch-producers scheduled function and returns them in the shape the
// dashboard's fetchProducerStocks() expects.
//
// Required Netlify env vars:
//   SUPABASE_URL              -> <your Supabase project URL>
//   SUPABASE_ANON_KEY         -> publishable/anon key (read-only, safe to use here)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// Static metadata matching CURVE_INDEX in the dashboard (IDX-201..204)
const META = {
  'VAL.JO': { id: 'IDX-201', company: 'Valterra Platinum', country: 'South Africa', production: '~1.7 Moz Pt/yr', exchange: 'JSE' },
  'IMP.JO': { id: 'IDX-202', company: 'Impala Platinum', country: 'South Africa', production: '~1.1 Moz Pt/yr', exchange: 'JSE' },
  'SSW.JO': { id: 'IDX-203', company: 'Sibanye-Stillwater', country: 'South Africa / USA', production: '~0.9 Moz Pt/yr', exchange: 'JSE' },
  'NPH.JO': { id: 'IDX-204', company: 'Northam Platinum', country: 'South Africa', production: '~0.5 Moz Pt/yr', exchange: 'JSE' },
};

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/producer_quotes?select=ticker,name,price,currency,change_pct,updated_at,source`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`);
    const rows = await res.json();

    const quotes = rows.map((r) => {
      const meta = META[r.ticker] || {};
      return {
        id: meta.id,
        company: meta.company,
        country: meta.country,
        production: meta.production,
        ticker: r.ticker,
        exchange: meta.exchange || 'JSE',
        priceZar: r.currency === 'ZAR' ? r.price : null,
        changePct: r.change_pct,
        updatedAt: r.updated_at,
      };
    });

    const oldestUpdate = rows.reduce((min, r) => {
      const t = new Date(r.updated_at).getTime();
      return t < min ? t : min;
    }, Date.now());
    const stale = (Date.now() - oldestUpdate) > 15 * 60 * 1000;

    return new Response(JSON.stringify({
      ok: true,
      quotes,
      announcements: [], // news-digest covers headline-level news; per-producer announcements not yet built
      updatedAt: new Date(oldestUpdate).toISOString(),
      stale,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200, // 200 so the dashboard's error-handling path reads .ok instead of throwing on HTTP status
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
