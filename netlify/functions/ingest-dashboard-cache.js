// netlify/functions/ingest-dashboard-cache.js
//
// Scheduled ingest — writes buy-intel, short-range crypto charts, and TA library
// to Supabase. Browser reads market_snapshots + ta_pattern_library directly (anon).

import { researchBuyAssets } from './lib/asset-intel.mjs';
import { TA_PATTERNS } from './lib/ta-library.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

const CHART_COINS = ['bitcoin', 'ethereum', 'conflux-token', 'tether-gold'];
const CHART_DAYS = ['1', '7', '30'];

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function upsertSnapshot(snapshotKey, payload, source) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/market_snapshots`, {
    method: 'POST',
    headers: {
      ...sbHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      snapshot_key: snapshotKey,
      payload,
      updated_at: new Date().toISOString(),
      source,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Snapshot upsert ${snapshotKey}: ${res.status} ${text.slice(0, 120)}`);
  }
}

function cgHeaders() {
  const h = { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/2.0)', Accept: 'application/json' };
  if (COINGECKO_API_KEY) h['x-cg-demo-api-key'] = COINGECKO_API_KEY;
  return h;
}

function withApiKey(url) {
  if (!COINGECKO_API_KEY) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}x_cg_demo_api_key=${COINGECKO_API_KEY}`;
}

async function fetchCoinGeckoChart(coinId, days) {
  const cgUrl = withApiKey(
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}`
  );
  const res = await fetch(cgUrl, { headers: cgHeaders() });
  if (!res.ok) throw new Error(`CoinGecko ${coinId}/${days}: ${res.status}`);
  const data = await res.json();
  if (!data.prices?.length) throw new Error(`CoinGecko ${coinId}/${days}: empty`);
  return data.prices;
}

async function ingestShortCharts() {
  const results = [];
  for (const coinId of CHART_COINS) {
    for (const days of CHART_DAYS) {
      const key = `chart:${coinId}:${days}`;
      try {
        const prices = await fetchCoinGeckoChart(coinId, days);
        await upsertSnapshot(key, { prices, coinId, days }, 'coingecko-ingest');
        results.push({ key, ok: true, count: prices.length });
      } catch (err) {
        console.error(key, err.message);
        results.push({ key, ok: false, error: err.message });
      }
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  return results;
}

async function ingestBuyIntel() {
  const assets = await researchBuyAssets(['platinum', 'cfx']);
  await upsertSnapshot('buy-intel', { assets, researchedAt: new Date().toISOString() }, 'asset-intel-ingest');
  return { ok: true, keys: Object.keys(assets) };
}

async function seedTaLibrary() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ta_pattern_library?select=slug&limit=1`, {
    headers: sbHeaders(),
  });
  if (!res.ok) throw new Error(`TA library read: ${res.status}`);
  const rows = await res.json();
  if (rows.length >= TA_PATTERNS.length) return { ok: true, seeded: 0 };

  let seeded = 0;
  for (const p of TA_PATTERNS) {
    const up = await fetch(`${SUPABASE_URL}/rest/v1/ta_pattern_library`, {
      method: 'POST',
      headers: {
        ...sbHeaders(),
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        slug: p.slug,
        title: p.title,
        bias: p.bias,
        summary: p.summary,
        theory: p.theory,
        diagram: p.diagram,
        updated_at: new Date().toISOString(),
      }),
    });
    if (up.ok) seeded += 1;
  }
  return { ok: true, seeded };
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const results = { buyIntel: null, charts: null, taLibrary: null };
  try {
    results.buyIntel = await ingestBuyIntel();
  } catch (err) {
    results.buyIntel = { ok: false, error: err.message };
  }
  try {
    results.charts = await ingestShortCharts();
  } catch (err) {
    results.charts = { ok: false, error: err.message };
  }
  try {
    results.taLibrary = await seedTaLibrary();
  } catch (err) {
    results.taLibrary = { ok: false, error: err.message };
  }

  console.log('ingest-dashboard-cache:', JSON.stringify(results));
  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
