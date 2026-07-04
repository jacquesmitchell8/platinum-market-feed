// netlify/functions/asset-deep-dive.js
//
// Deep web intelligence for buy candidates (Platinum + Conflux by default).
// Multi-query Google News sweeps, entity mentions, directional narrative.

import { researchBuyAssets } from './lib/asset-intel.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
    return new Response(JSON.stringify({
      ok: true,
      assets,
      researchedAt: new Date().toISOString(),
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=1800, stale-while-revalidate=3600',
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
