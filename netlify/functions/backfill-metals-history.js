// netlify/functions/backfill-metals-history.js
//
// ONE-TIME backfill — not scheduled, not called by the dashboard. Run this
// manually by visiting its URL repeatedly (or clicking "Run now" in Netlify's
// Functions tab repeatedly) until it reports done:true. Each invocation
// processes a few 30-day chunks and stores its progress in Supabase, picking
// up where it left off — this is necessary because Netlify's free tier caps
// function execution at 10 seconds, which is nowhere near enough time to
// fetch+write 10 years of data (~122 chunks) in one go.
//
// After it reports done:true, this is done — fetch-market-snapshots.js's
// existing daily append takes over going forward. No need to run this again.
//
// Required Netlify env vars:
//   METALS_DEV_API_KEY        -> free key from metals.dev dashboard
//   SUPABASE_URL              -> <your Supabase project URL>
//   SUPABASE_SERVICE_ROLE_KEY -> secret key (writes, not just reads)

const METALS_DEV_API_KEY = process.env.METALS_DEV_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BACKFILL_YEARS = 10;
const CHUNK_DAYS = 30;
const CHUNKS_PER_INVOCATION = 4; // tuned to comfortably fit inside the 10s free-tier limit
const PROGRESS_KEY = 'backfill_metals_progress';

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

async function getProgress() {
  const url = `${SUPABASE_URL}/rest/v1/market_snapshots?select=payload&snapshot_key=eq.${PROGRESS_KEY}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0]?.payload || null;
}

async function saveProgress(payload) {
  const url = `${SUPABASE_URL}/rest/v1/market_snapshots`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      snapshot_key: PROGRESS_KEY,
      payload,
      updated_at: new Date().toISOString(),
      source: 'backfill-metals-history',
    })
  });
}

async function fetchChunk(startDate, endDate) {
  const url = `https://api.metals.dev/v1/timeseries?api_key=${METALS_DEV_API_KEY}&start_date=${formatDate(startDate)}&end_date=${formatDate(endDate)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Metals.Dev fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.status !== 'success') throw new Error(`Metals.Dev error: ${data.error_message || 'unknown'}`);
  return data.rates;
}

async function upsertHistoryRow(asset, price, dateStr) {
  const url = `${SUPABASE_URL}/rest/v1/metal_price_history`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=ignore-duplicates'
    },
    body: JSON.stringify({ asset, price, recorded_at: `${dateStr}T12:00:00Z` })
  });
  return res.ok;
}

export default async (req) => {
  if (!METALS_DEV_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing required env vars' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const overallEnd = new Date();
  const overallStart = new Date();
  overallStart.setFullYear(overallStart.getFullYear() - BACKFILL_YEARS);

  const progress = await getProgress();
  let cursor = progress?.cursor ? new Date(progress.cursor) : new Date(overallStart);
  let totalGold = progress?.totalGold || 0;
  let totalPlat = progress?.totalPlat || 0;
  const errors = progress?.errors || [];

  if (cursor >= overallEnd) {
    return new Response(JSON.stringify({
      ok: true, done: true,
      summary: `Backfill already complete. ${totalGold} gold rows, ${totalPlat} platinum rows written total. Safe to stop calling this function now.`,
      errors,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  let chunksThisRun = 0;
  while (cursor < overallEnd && chunksThisRun < CHUNKS_PER_INVOCATION) {
    let chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + CHUNK_DAYS - 1);
    if (chunkEnd > overallEnd) chunkEnd = new Date(overallEnd);

    try {
      const rates = await fetchChunk(cursor, chunkEnd);
      for (const [dateStr, dayData] of Object.entries(rates)) {
        const gold = dayData?.metals?.gold;
        const platinum = dayData?.metals?.platinum;
        if (gold != null && await upsertHistoryRow('XAU', gold, dateStr)) totalGold++;
        if (platinum != null && await upsertHistoryRow('XPT', platinum, dateStr)) totalPlat++;
      }
    } catch (err) {
      errors.push(`${formatDate(cursor)} to ${formatDate(chunkEnd)}: ${err.message}`);
    }

    cursor.setDate(cursor.getDate() + CHUNK_DAYS);
    chunksThisRun++;
  }

  const done = cursor >= overallEnd;
  await saveProgress({ cursor: cursor.toISOString(), totalGold, totalPlat, errors });

  return new Response(JSON.stringify({
    ok: true,
    done,
    progress: `${formatDate(cursor)} of ${formatDate(overallEnd)}`,
    summary: done
      ? `Backfill complete! ${totalGold} gold rows, ${totalPlat} platinum rows written total.`
      : `In progress — ${totalGold} gold / ${totalPlat} platinum rows so far. Call this function again to continue (reload the URL).`,
    errors,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
