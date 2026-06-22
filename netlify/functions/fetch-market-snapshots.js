// netlify/functions/fetch-market-snapshots.js
//
// Scheduled function — runs every 5 minutes (see netlify.toml).
// Fetches live metals + crypto prices and upserts one row per asset
// into Supabase `market_snapshots` (snapshot_key, payload, updated_at, source).
//
// Required Netlify env vars (set in Netlify dashboard -> Site configuration -> Environment variables):
//   SUPABASE_URL              -> <your Supabase project URL>
//   SUPABASE_SERVICE_ROLE_KEY -> secret key (NEVER the anon/publishable key, NEVER exposed to browser)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const METALS = ['XAU', 'XPT'];
const CRYPTO_IDS = {
  CFX: 'conflux-token',
  ETH: 'ethereum',
  BTC: 'bitcoin'
};

async function fetchMetal(symbol) {
  const res = await fetch(`https://api.gold-api.com/price/${symbol}`);
  if (!res.ok) throw new Error(`${symbol} fetch failed: ${res.status}`);
  const data = await res.json();
  return {
    asset: symbol,
    price: data.price,
    currency: 'usd',
    unit: 'oz',
    raw_timestamp: data.timestamp || data.updatedAt || null
  };
}

async function fetchCrypto(symbol, geckoId) {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd&include_last_updated_at=true`
  );
  if (!res.ok) throw new Error(`${symbol} fetch failed: ${res.status}`);
  const data = await res.json();
  const entry = data[geckoId];
  if (!entry) throw new Error(`${symbol} missing from CoinGecko response`);
  return {
    asset: symbol,
    price: entry.usd,
    currency: 'usd',
    unit: 'token',
    raw_timestamp: entry.last_updated_at ? entry.last_updated_at * 1000 : null
  };
}

async function upsertSnapshot(snapshotKey, payload, source) {
  const url = `${SUPABASE_URL}/rest/v1/market_snapshots`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      snapshot_key: snapshotKey,
      payload,
      updated_at: new Date().toISOString(),
      source
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upsert failed for ${snapshotKey}: ${res.status} ${text}`);
  }
}

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    return new Response('Missing env vars', { status: 500 });
  }

  const results = [];

  for (const symbol of METALS) {
    try {
      const data = await fetchMetal(symbol);
      await upsertSnapshot(symbol, data, 'gold-api.com');
      results.push({ asset: symbol, ok: true });
    } catch (err) {
      console.error(err.message);
      results.push({ asset: symbol, ok: false, error: err.message });
    }
  }

  for (const [symbol, geckoId] of Object.entries(CRYPTO_IDS)) {
    try {
      const data = await fetchCrypto(symbol, geckoId);
      await upsertSnapshot(symbol, data, 'coingecko.com');
      results.push({ asset: symbol, ok: true });
    } catch (err) {
      console.error(err.message);
      results.push({ asset: symbol, ok: false, error: err.message });
    }
  }

  console.log('Snapshot run complete:', JSON.stringify(results));

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
