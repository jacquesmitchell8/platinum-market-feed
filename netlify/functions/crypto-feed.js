// netlify/functions/crypto-feed.js
//
// On-demand function — proxies CoinGecko chart requests server-side.
// The dashboard was hitting CoinGecko directly from the browser for BTC/ETH/CFX
// history, and combined with the live ticker's 60s polling, that triggered
// CoinGecko's free-tier rate limit (HTTP 429) from this IP. Routing through
// here doesn't eliminate rate limits entirely, but server-side requests are
// fewer (one dashboard load vs. every visitor's browser hitting CoinGecko
// directly) and we can add caching here later if needed.
//
// Matches the two call shapes the dashboard already expects:
//   ?type=chart&id=<coingecko-id>&days=<n|max>   -> { ok, prices: [[ts, price], ...] }
//   ?type=metal&symbol=<sym>&days=<n>            -> delegates to metals-chart logic (gold/platinum)

export default async (req) => {
  const url = new URL(req.url);
  const type = url.searchParams.get('type');

  try {
    if (type === 'chart') {
      const id = url.searchParams.get('id');
      const daysParam = url.searchParams.get('days');
      const days = daysParam === 'max' ? 'max' : daysParam;
      if (!id) throw new Error('Missing id parameter');

      const interval = days !== 'max' && +days >= 2 && +days <= 30 ? '&interval=hourly' : '';
      const cgUrl = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}${interval}`;

      const res = await fetch(cgUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/1.0)' }
      });
      if (!res.ok) throw new Error(`CoinGecko fetch failed: ${res.status}`);
      const data = await res.json();
      if (!data.prices?.length) throw new Error('CoinGecko returned no price data');

      return new Response(JSON.stringify({ ok: true, prices: data.prices, source: 'coingecko' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (type === 'metal') {
      // Same logic as metals-chart.js — kept here too since the dashboard
      // tries this URL first (see fetchMetalProxy) before falling back to
      // /.netlify/functions/metals-chart.
      const symbol = url.searchParams.get('symbol');
      const daysParam = url.searchParams.get('days');
      const days = daysParam === 'max' || !daysParam ? null : parseInt(daysParam, 10);
      if (!symbol) throw new Error('Missing symbol parameter');

      const range = days == null ? '5y' : days <= 1 ? '5d' : days <= 7 ? '1mo' : days <= 30 ? '3mo' : days <= 90 ? '6mo' : days <= 365 ? '2y' : days <= 1095 ? '5y' : '10y';
      const interval = days == null || days > 365 ? '1d' : days <= 7 ? '1h' : '1d';
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
        if (closes[i] != null) prices.push([timestamps[i] * 1000, closes[i]]);
      }
      if (!prices.length) throw new Error('No valid price points returned');

      return new Response(JSON.stringify({ ok: true, prices, source: 'yahoo-finance' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    throw new Error(`Unknown or missing type parameter: ${type}`);
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
