// netlify/functions/metals-chart.js
//
// On-demand function — called by the dashboard's fetchMetalProxy() whenever
// the Index Timeline chart needs gold or platinum price history. Uses Yahoo
// Finance's unofficial v8 chart endpoint for futures (GC=F gold, PL=F platinum),
// same reliable pattern already proven working for the JSE producer quotes.
//
// Returns { ok: true, prices: [[timestamp_ms, price], ...] } — the exact shape
// fetchMetalProxy() expects, so no changes needed on the dashboard side.
//
// No Supabase involved here — purely a stateless proxy to Yahoo Finance,
// since historical chart data doesn't need to be cached server-side the way
// the live ticker snapshot does.

const RANGE_FOR_DAYS = (days) => {
  // Yahoo's range param accepts: 1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max
  if (days == null) return '5y';
  if (days <= 1) return '5d';
  if (days <= 7) return '1mo';
  if (days <= 30) return '3mo';
  if (days <= 90) return '6mo';
  if (days <= 365) return '2y';
  if (days <= 1095) return '5y';
  return '10y';
};

const INTERVAL_FOR_DAYS = (days) => {
  if (days == null || days > 365) return '1d';
  if (days <= 7) return '1h';
  return '1d';
};

export default async (req) => {
  const url = new URL(req.url);
  const symbol = url.searchParams.get('symbol'); // 'GC=F' or 'PL=F'
  const daysParam = url.searchParams.get('days');
  const days = daysParam === 'max' || !daysParam ? null : parseInt(daysParam, 10);

  if (!symbol) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing symbol parameter' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const range = RANGE_FOR_DAYS(days);
    const interval = INTERVAL_FOR_DAYS(days);
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;

    const res = await fetch(yahooUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/1.0)' }
    });
    if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status}`);

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No chart result from Yahoo');

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];

    const prices = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null) {
        prices.push([timestamps[i] * 1000, closes[i]]);
      }
    }

    if (!prices.length) throw new Error('No valid price points returned');

    return new Response(JSON.stringify({ ok: true, prices, source: 'yahoo-finance', symbol }), {
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
