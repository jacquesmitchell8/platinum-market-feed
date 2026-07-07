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
const MINTED_METAL_URL = 'https://mintedmetal.com/api/prices.json';
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

function pctChg(cur, prev) {
  if (cur == null || prev == null || !prev) return null;
  return ((cur - prev) / prev) * 100;
}

/** LBMA-aligned spot via Minted Metal (previous fix → current fix = daily move). */
async function fetchLbmaMetals() {
  const res = await fetch(MINTED_METAL_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/2.0)' },
  });
  if (!res.ok) throw new Error(`Minted Metal fetch failed: ${res.status}`);
  const data = await res.json();
  const metals = data?.metals;
  if (!metals?.gold?.price || !metals?.platinum?.price) {
    throw new Error('Minted Metal response missing gold/platinum');
  }
  const out = {};
  for (const [key, symbol] of [['gold', 'XAU'], ['platinum', 'XPT']]) {
    const m = metals[key];
    const previousPrice = m.previousPrice ?? null;
    out[symbol] = {
      asset: symbol,
      price: m.price,
      previousPrice,
      chg: pctChg(m.price, previousPrice),
      currency: 'usd',
      unit: 'oz',
      raw_timestamp: data.updatedAt || data.timestamp || null,
    };
  }
  return out;
}

async function fetchCrypto(symbol, geckoId) {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`
  );
  if (!res.ok) throw new Error(`${symbol} fetch failed: ${res.status}`);
  const data = await res.json();
  const entry = data[geckoId];
  if (!entry) throw new Error(`${symbol} missing from CoinGecko response`);
  return {
    asset: symbol,
    price: entry.usd,
    chg: entry.usd_24h_change ?? null,
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

// Appends one row per metal per UTC day into metal_price_history, building
// real chartable history over time with zero dependency on any third-party
// historical price API (Yahoo blocks unauthenticated server requests; this
// avoids that problem entirely by accumulating our own data).
async function appendMetalHistory(symbol, price) {
  const url = `${SUPABASE_URL}/rest/v1/metal_price_history`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=ignore-duplicates' // the unique (asset, day) index makes repeat same-day inserts no-ops
    },
    body: JSON.stringify({
      asset: symbol,
      price,
      recorded_at: new Date().toISOString(),
      recorded_day: new Date().toISOString().slice(0, 10),
    })
  });
  if (!res.ok) {
    console.error(`metal_price_history append failed for ${symbol}: ${res.status}`);
  }
}

async function appendCryptoHistory(symbol, price) {
  const url = `${SUPABASE_URL}/rest/v1/crypto_price_history`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=ignore-duplicates'
    },
    body: JSON.stringify({
      asset: symbol,
      price,
      recorded_at: new Date().toISOString(),
      recorded_day: new Date().toISOString().slice(0, 10),
    })
  });
  if (!res.ok) {
    console.error(`crypto_price_history append failed for ${symbol}: ${res.status}`);
  }
}

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    return new Response('Missing env vars', { status: 500 });
  }

  const results = [];

  try {
    const lbma = await fetchLbmaMetals();
    for (const symbol of METALS) {
      try {
        const data = lbma[symbol];
        if (!data) throw new Error('Missing LBMA row');
        await upsertSnapshot(symbol, data, 'mintedmetal.com');
        await appendMetalHistory(symbol, data.price);
        results.push({ asset: symbol, ok: true, source: 'mintedmetal.com' });
      } catch (err) {
        console.error(err.message);
        results.push({ asset: symbol, ok: false, error: err.message });
      }
    }
  } catch (err) {
    console.error('Minted Metal batch failed, falling back to gold-api:', err.message);
    for (const symbol of METALS) {
      try {
        const data = await fetchMetal(symbol);
        await upsertSnapshot(symbol, { ...data, chg: null }, 'gold-api.com');
        await appendMetalHistory(symbol, data.price);
        results.push({ asset: symbol, ok: true, source: 'gold-api.com-fallback' });
      } catch (inner) {
        console.error(inner.message);
        results.push({ asset: symbol, ok: false, error: inner.message });
      }
    }
  }

  for (const [symbol, geckoId] of Object.entries(CRYPTO_IDS)) {
    try {
      const data = await fetchCrypto(symbol, geckoId);
      await upsertSnapshot(symbol, data, 'coingecko.com');
      await appendCryptoHistory(symbol, data.price);
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
