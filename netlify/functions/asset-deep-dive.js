// netlify/functions/asset-deep-dive.js
//
// On-demand buy intel (Platinum + Conflux). Also writes market_snapshots.buy-intel
// so Refresh and the hourly ingest share the same store.
// Hourly path: ingest-dashboard-cache → researchBuyAssets.

import { researchBuyAssets } from './lib/asset-intel.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function upsertBuyIntel(assets) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return { saved: false, reason: 'no supabase env' };
  const researchedAt = new Date().toISOString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/market_snapshots`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      snapshot_key: 'buy-intel',
      payload: { assets, researchedAt },
      updated_at: researchedAt,
      source: 'asset-deep-dive-on-demand',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { saved: false, reason: `${res.status} ${text.slice(0, 120)}` };
  }
  return { saved: true };
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const assetsParam = url.searchParams.get('assets') || 'platinum,cfx';
  const assetKeys = assetsParam
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  try {
    const assets = await researchBuyAssets(assetKeys);
    const persist = await upsertBuyIntel(assets);
    return new Response(JSON.stringify({
      ok: true,
      assets,
      researchedAt: new Date().toISOString(),
      persisted: persist,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...CORS,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }
};
