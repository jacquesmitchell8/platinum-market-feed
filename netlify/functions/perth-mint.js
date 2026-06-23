// netlify/functions/perth-mint.js
//
// IMPORTANT — READ BEFORE MODIFYING:
// The Perth Mint does not publish a public API — only a retail website with
// no documented JSON endpoint. Scraping it was considered and rejected (see
// conversation history) as circumventing a deliberate choice not to expose
// this data programmatically.
//
// What this function returns instead: a clearly-labeled ESTIMATE derived
// from our own accumulated gold/platinum history (metal_price_history in
// Supabase, built by fetch-market-snapshots.js — NOT Yahoo Finance, which
// blocks unauthenticated server requests with 401/404 anti-scraping errors).
// Every data point is tagged `estimated: true` and the response carries a
// `disclaimer` field. This is NOT real Perth Mint retail pricing.
//
// Required Netlify env vars:
//   SUPABASE_URL      -> <your Supabase project URL>
//   SUPABASE_ANON_KEY -> publishable/anon key (read-only, safe to use here)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

async function fetchAudUsdRate() {
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?from=AUD&to=USD');
    if (!res.ok) throw new Error('Frankfurter fetch failed');
    const j = await res.json();
    if (j.rates?.USD) return j.rates.USD;
  } catch (_) {}
  return 0.65;
}

async function fetchOwnHistory(asset) {
  // Same logic as metals-history.js — kept inline here to avoid one function
  // calling another over HTTP, which Netlify functions can't do directly anyway.
  const histUrl = `${SUPABASE_URL}/rest/v1/metal_price_history?select=price,recorded_at&asset=eq.${asset}&order=recorded_at.asc&limit=5000`;
  try {
    const res = await fetch(histUrl, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) {
        return rows.map(r => ({ ts: new Date(r.recorded_at).getTime(), usdPerOz: r.price }));
      }
    }
  } catch (_) {}

  // Fall back to just the current snapshot if history table is empty/missing.
  const snapUrl = `${SUPABASE_URL}/rest/v1/market_snapshots?select=payload,updated_at&snapshot_key=eq.${asset}`;
  const snapRes = await fetch(snapUrl, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!snapRes.ok) return [];
  const rows = await snapRes.json();
  if (!rows.length) return [];
  return [{ ts: new Date(rows[0].updated_at).getTime(), usdPerOz: rows[0].payload.price }];
}

function buildHistoricArray(usdPoints, audUsdRate) {
  return usdPoints.map((p) => {
    const audMid = p.usdPerOz / audUsdRate;
    const spread = audMid * 0.015; // synthetic ~1.5% retail spread, since we have no real bid/offer
    return {
      timestamp: p.ts,
      mid: Math.round(audMid * 100) / 100,
      offer: Math.round((audMid + spread) * 100) / 100,
      bid: Math.round((audMid - spread) * 100) / 100,
      estimated: true,
    };
  });
}

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const audUsdRate = await fetchAudUsdRate();
    const goldRaw = await fetchOwnHistory('XAU');
    const platRaw = await fetchOwnHistory('XPT');

    const goldHist = buildHistoricArray(goldRaw, audUsdRate);
    const platHist = buildHistoricArray(platRaw, audUsdRate);

    const goldEntry = {
      metal: 'Gold',
      currency: 'AUD',
      estimated: true,
      oneWeekHistoricData: goldHist.slice(-40),
      twoYearsHistoricData: goldHist,
      threeYearsHistoricData: goldHist,
      fiveYearsHistoricData: goldHist,
    };

    const platEntry = {
      metal: 'Platinum',
      currency: 'AUD',
      estimated: true,
      oneWeekHistoricData: platHist.slice(-40),
      twoYearsHistoricData: platHist,
      threeYearsHistoricData: platHist,
      fiveYearsHistoricData: platHist,
    };

    return new Response(JSON.stringify({
      ok: true,
      estimated: true,
      disclaimer: 'ESTIMATE ONLY — Perth Mint has no public API. These figures are derived from our own accumulated spot gold/platinum data converted to AUD with a synthetic retail spread, NOT real Perth Mint bid/offer prices. History accumulates daily and starts thin. For actual retail pricing, see perthmint.com directly.',
      result: [goldEntry, platEntry],
      audUsdRate,
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
