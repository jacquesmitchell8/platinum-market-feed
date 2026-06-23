// netlify/functions/crypto-history.js
//
// Same self-filling pattern as metals-history.js:
//   1. Read our own crypto_price_history from Supabase
//   2. If there's a gap, fetch only the missing range from CoinGecko
//   3. Append new rows and return the full merged curve
//
// Required Netlify env vars:
//   COINGECKO_API_KEY           -> Demo API key (optional but recommended)
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ASSET_TO_GECKO = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  CFX: 'conflux-token',
};
const GECKO_TO_ASSET = Object.fromEntries(Object.entries(ASSET_TO_GECKO).map(([k, v]) => [v, k]));

const BACKFILL_DAYS = 365 * 5;

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function withApiKey(url) {
  if (!COINGECKO_API_KEY) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}x_cg_demo_api_key=${COINGECKO_API_KEY}`;
}

async function getStoredHistory(asset) {
  const url = `${SUPABASE_URL}/rest/v1/crypto_price_history?select=price,recorded_at&asset=eq.${asset}&order=recorded_at.asc&limit=10000`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!res.ok) return [];
  return res.json();
}

async function upsertHistoryRow(asset, price, dateStr) {
  await fetch(`${SUPABASE_URL}/rest/v1/crypto_price_history`, {
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

async function fetchCoinGeckoHistory(geckoId, days) {
  const cgUrl = withApiKey(
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(geckoId)}/market_chart?vs_currency=usd&days=${days}`
  );
  const res = await fetch(cgUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/1.0)' }
  });
  if (!res.ok) throw new Error(`CoinGecko fetch failed: ${res.status}`);
  const data = await res.json();
  if (!data.prices?.length) throw new Error('CoinGecko returned no price data');
  return data.prices;
}

function pricesToDailyMap(prices) {
  const byDay = new Map();
  for (const [ts, price] of prices) {
    const day = formatDate(new Date(ts));
    byDay.set(day, price);
  }
  return byDay;
}

async function fillGap(asset, geckoId, fromDate, toDate) {
  const daysNeeded = Math.ceil((toDate - fromDate) / 86400000) + 2;
  const daysParam = Math.min(Math.max(daysNeeded, 7), BACKFILL_DAYS);
  const prices = await fetchCoinGeckoHistory(geckoId, daysParam);
  const byDay = pricesToDailyMap(prices);
  const newPoints = [];
  const fromStr = formatDate(fromDate);

  for (const [day, price] of byDay) {
    if (day >= fromStr && day <= formatDate(toDate)) {
      await upsertHistoryRow(asset, price, day);
      newPoints.push({ ts: new Date(day).getTime(), price });
    }
  }
  return newPoints;
}

export default async (req) => {
  const url = new URL(req.url);
  const requested = url.searchParams.get('id') || url.searchParams.get('symbol');
  const asset = GECKO_TO_ASSET[requested] || requested;
  const geckoId = ASSET_TO_GECKO[asset] || requested;

  if (!asset || !geckoId) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing id/symbol parameter' }), {
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
    oldestWanted.setDate(oldestWanted.getDate() - BACKFILL_DAYS);

    const lastStoredDate = stored.length ? new Date(stored[stored.length - 1].recorded_at) : null;
    const gapStart = lastStoredDate && lastStoredDate > oldestWanted ? lastStoredDate : oldestWanted;

    let newPoints = [];
    if (gapStart < today) {
      try {
        newPoints = await fillGap(asset, geckoId, gapStart, today);
      } catch (err) {
        console.error(`crypto gap-fill failed for ${asset}: ${err.message}`);
      }
    }

    const existingPoints = stored.map(r => ({ ts: new Date(r.recorded_at).getTime(), price: r.price }));
    const allPoints = [...existingPoints, ...newPoints]
      .sort((a, b) => a.ts - b.ts)
      .filter((p, i, arr) => i === 0 || formatDate(new Date(p.ts)) !== formatDate(new Date(arr[i - 1].ts)));

    if (!allPoints.length) {
      return new Response(JSON.stringify({ ok: false, error: 'No data available yet for ' + asset }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    const prices = allPoints.map(p => [p.ts, p.price]);
    return new Response(JSON.stringify({ ok: true, prices, source: 'self-filling-crypto-history' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
};
