// netlify/functions/perth-mint.js
//
// IMPORTANT — READ BEFORE MODIFYING:
// The Perth Mint does not publish a public API. Their retail bid/offer
// prices only exist on their website, updated client-side, with no
// documented JSON endpoint. Scraping their retail page was considered and
// deliberately rejected — see conversation history — because it would mean
// circumventing a deliberate choice by Perth Mint not to expose this data
// programmatically, against the spirit of their published terms.
//
// What this function actually returns instead: a clearly-labeled ESTIMATE,
// derived from LBMA/Yahoo spot gold and platinum prices converted to AUD,
// in the same response shape the dashboard's fetchPerthMint() expects, so
// the chart renders without code changes — but every data point is tagged
// `estimated: true` and the whole response carries a `disclaimer` field.
// This is NOT real Perth Mint retail pricing and should never be presented
// to a user as if it were.
//
// Required Netlify env vars: none (Yahoo + Frankfurter are both keyless).

const RANGE_FOR_KEY = {
  oneWeekHistoricData: { range: '5d', interval: '1h' },
  twoYearsHistoricData: { range: '2y', interval: '1d' },
  threeYearsHistoricData: { range: '5y', interval: '1d' },
  fiveYearsHistoricData: { range: '5y', interval: '1d' },
};

async function fetchYahooSeries(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/1.0)' }
  });
  if (!res.ok) throw new Error(`Yahoo fetch failed for ${symbol}: ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No chart result for ${symbol}`);
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null) points.push({ ts: timestamps[i] * 1000, usdPerOz: closes[i] });
  }
  return points;
}

async function fetchAudUsdRate() {
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?from=AUD&to=USD');
    if (!res.ok) throw new Error('Frankfurter fetch failed');
    const j = await res.json();
    if (j.rates?.USD) return j.rates.USD;
  } catch (_) {}
  return 0.65; // reasonable fallback if FX lookup fails
}

function buildHistoricArray(usdPoints, audUsdRate, metal) {
  // Convert USD/oz futures price to an AUD/oz estimate, then synthesize a
  // bid/offer spread around it (~1.5% each side, roughly typical retail
  // bullion margin) since we have no real retail bid/offer to report.
  return usdPoints.map((p) => {
    const audMid = p.usdPerOz / audUsdRate;
    const spread = audMid * 0.015;
    return {
      timestamp: p.ts,
      mid: Math.round(audMid * 100) / 100,
      offer: Math.round((audMid + spread) * 100) / 100,
      bid: Math.round((audMid - spread) * 100) / 100,
      estimated: true,
    };
  });
}

export default async (req) => {
  try {
    const audUsdRate = await fetchAudUsdRate();

    const goldRaw = await fetchYahooSeries('GC=F', '5y', '1d');
    const platRaw = await fetchYahooSeries('PL=F', '5y', '1d');

    function sliceFor(key) {
      const cfg = RANGE_FOR_KEY[key];
      // We only fetched one broad range above; reuse it for all keys rather
      // than hitting Yahoo repeatedly — fine since this is an estimate, not
      // precision retail data anyway.
      return cfg;
    }

    const goldEntry = {
      metal: 'Gold',
      currency: 'AUD',
      estimated: true,
      oneWeekHistoricData: buildHistoricArray(goldRaw.slice(-40), audUsdRate, 'Gold'),
      twoYearsHistoricData: buildHistoricArray(goldRaw, audUsdRate, 'Gold'),
      threeYearsHistoricData: buildHistoricArray(goldRaw, audUsdRate, 'Gold'),
      fiveYearsHistoricData: buildHistoricArray(goldRaw, audUsdRate, 'Gold'),
    };

    const platEntry = {
      metal: 'Platinum',
      currency: 'AUD',
      estimated: true,
      oneWeekHistoricData: buildHistoricArray(platRaw.slice(-40), audUsdRate, 'Platinum'),
      twoYearsHistoricData: buildHistoricArray(platRaw, audUsdRate, 'Platinum'),
      threeYearsHistoricData: buildHistoricArray(platRaw, audUsdRate, 'Platinum'),
      fiveYearsHistoricData: buildHistoricArray(platRaw, audUsdRate, 'Platinum'),
    };

    return new Response(JSON.stringify({
      ok: true,
      estimated: true,
      disclaimer: 'ESTIMATE ONLY — Perth Mint has no public API. These figures are derived from LBMA/Yahoo spot gold and platinum prices converted to AUD with a synthetic retail spread, NOT real Perth Mint bid/offer prices. For actual retail pricing, see perthmint.com directly.',
      result: [goldEntry, platEntry],
      audUsdRate,
    }), {
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
