// netlify/functions/metals-history.js
//
// Called by the dashboard every time the gold/platinum chart loads.
//
// What it does, every single call:
//   1. Check our own stored history (metal_price_history in Supabase) for
//      this asset.
//   2. If there's a gap between the last stored entry and today, fetch ONLY
//      that missing range from Metals.Dev (free, no card, real daily gold
//      + platinum data) and write it in.
//   3. Return the full merged curve.
//
// No separate backfill step. No manual triggering. No reloading anything.
// The first time this runs there's no history yet, so it fills ~10 years in
// one go (chunked internally to respect Metals.Dev's 30-day-per-call limit
// and Netlify's execution time budget) — after that, there's nothing left to
// fill, so every later call is fast and just reads what's already stored.
//
// Required Netlify env vars:
//   METALS_DEV_API_KEY        -> free key from metals.dev dashboard
//   SUPABASE_URL              -> <your Supabase project URL>
//   SUPABASE_SERVICE_ROLE_KEY -> secret key (this writes, not just reads)

const METALS_DEV_API_KEY = process.env.METALS_DEV_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BACKFILL_YEARS = 10;
const CHUNK_DAYS = 30;
const MAX_CHUNKS_THIS_CALL = 15; // each chunk is ~30 days; 15 ≈ 450 days per call

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

async function getStoredHistory(asset) {
  const url = `${SUPABASE_URL}/rest/v1/metal_price_history?select=price,recorded_at&asset=eq.${asset}&order=recorded_at.asc&limit=10000`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!res.ok) return [];
  return res.json();
}

async function fetchMetalsDevChunk(startDate, endDate) {
  const url = `https://api.metals.dev/v1/timeseries?api_key=${METALS_DEV_API_KEY}&start_date=${formatDate(startDate)}&end_date=${formatDate(endDate)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Metals.Dev fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.status !== 'success') throw new Error(`Metals.Dev error: ${data.error_message || 'unknown'}`);
  return data.rates; // { "2023-01-01": { metals: { gold, platinum } }, ... }
}

async function upsertHistoryRow(asset, price, dateStr) {
  const url = `${SUPABASE_URL}/rest/v1/metal_price_history`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=ignore-duplicates'
    },
    body: JSON.stringify({ asset, price, recorded_at: `${dateStr}T12:00:00Z`, recorded_day: dateStr })
  });
}

// Fetches and stores whatever's missing between `from` and `to`, for BOTH
// gold and platinum at once (Metals.Dev returns both in the same response,
// so we fill both assets' gaps together regardless of which one triggered
// this call) — chunked to stay inside the time budget for one call.
async function fillGap(from, to) {
  let cursor = new Date(from);
  const end = new Date(to);
  let chunks = 0;
  const newRows = { XAU: [], XPT: [] };

  while (cursor < end && chunks < MAX_CHUNKS_THIS_CALL) {
    let chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + CHUNK_DAYS - 1);
    if (chunkEnd > end) chunkEnd = new Date(end);

    try {
      const rates = await fetchMetalsDevChunk(cursor, chunkEnd);
      for (const [dateStr, dayData] of Object.entries(rates)) {
        const gold = dayData?.metals?.gold;
        const platinum = dayData?.metals?.platinum;
        if (gold != null) {
          await upsertHistoryRow('XAU', gold, dateStr);
          newRows.XAU.push({ ts: new Date(dateStr).getTime(), price: gold });
        }
        if (platinum != null) {
          await upsertHistoryRow('XPT', platinum, dateStr);
          newRows.XPT.push({ ts: new Date(dateStr).getTime(), price: platinum });
        }
      }
    } catch (_) {
      // If Metals.Dev hiccups on one chunk, skip it — next call will retry
      // this same gap since it's still missing from storage.
    }

    cursor.setDate(cursor.getDate() + CHUNK_DAYS);
    chunks++;
  }

  return newRows;
}

export default async (req) => {
  const url = new URL(req.url);
  const requested = url.searchParams.get('symbol'); // 'XAU'/'XPT' or legacy 'GC=F'/'PL=F'
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
    const stored = await getStoredHistory(asset);
    const today = new Date();
    const oldestWanted = new Date();
    oldestWanted.setFullYear(oldestWanted.getFullYear() - BACKFILL_YEARS);

    const firstStoredDate = stored.length ? new Date(stored[0].recorded_at) : null;
    const lastStoredDate = stored.length ? new Date(stored[stored.length - 1].recorded_at) : null;

    let newPoints = { XAU: [], XPT: [] };
    if (METALS_DEV_API_KEY) {
      // Backfill the past: snapshots may have added recent days only, leaving
      // a decade-sized hole — fill from oldestWanted up to our earliest row.
      const needsBackfill = !firstStoredDate || firstStoredDate > oldestWanted;
      if (needsBackfill) {
        const backEnd = firstStoredDate && firstStoredDate > oldestWanted ? firstStoredDate : today;
        const back = await fillGap(oldestWanted, backEnd);
        newPoints.XAU.push(...back.XAU);
        newPoints.XPT.push(...back.XPT);
      }
      // Forward fill: catch up from the latest stored day to today.
      if (lastStoredDate && lastStoredDate < today) {
        const fwd = await fillGap(lastStoredDate, today);
        newPoints.XAU.push(...fwd.XAU);
        newPoints.XPT.push(...fwd.XPT);
      }
    }

    const existingPoints = stored.map(r => ({ ts: new Date(r.recorded_at).getTime(), price: r.price }));
    const allPoints = [...existingPoints, ...newPoints[asset]]
      .sort((a, b) => a.ts - b.ts)
      // de-dupe same-day points (gap-fill may slightly overlap the last stored day)
      .filter((p, i, arr) => i === 0 || new Date(p.ts).toDateString() !== new Date(arr[i - 1].ts).toDateString());

    if (!allPoints.length) {
      return new Response(JSON.stringify({ ok: false, error: 'No data available yet for ' + asset }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    const prices = allPoints.map(p => [p.ts, p.price]);
    return new Response(JSON.stringify({ ok: true, prices, source: 'self-filling-history' }), {
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
