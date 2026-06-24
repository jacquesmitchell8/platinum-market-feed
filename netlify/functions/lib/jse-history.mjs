/**
 * JSE producer daily history.
 *
 * Source priority for .JO tickers:
 *   1. Yahoo Finance (free, works for JSE when not rate-limited)
 *   2. FMP stable API (free tier is US-only — JSE returns 402)
 */

export const PRODUCER_TICKERS = ['VAL.JO', 'IMP.JO', 'SSW.JO', 'NPH.JO'];

const HISTORY_ALIASES = {
  // AMS.JO (Anglo American Platinum) delisted on Yahoo — skip to avoid wasted retries
};

let lastYahooMs = 0;
const YAHOO_GAP_MS = 12000;
const YAHOO_429_WAIT_MS = 20000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function parsePointsFromDays(points) {
  return points.sort((a, b) => a.day.localeCompare(b.day));
}

function parseFmpRows(data) {
  if (Array.isArray(data) && data.length) {
    const points = [];
    for (const row of data) {
      const close = row.close != null ? Number(row.close) : row.price != null ? Number(row.price) : null;
      if (close == null || Number.isNaN(close)) continue;
      const day = String(row.date).slice(0, 10);
      points.push({ day, price: close, ts: new Date(`${day}T12:00:00Z`).getTime() });
    }
    if (points.length) return parsePointsFromDays(points);
  }
  if (data?.historical?.length) {
    const points = [];
    for (const row of data.historical) {
      const close = row.close != null ? Number(row.close) : null;
      if (close == null || Number.isNaN(close)) continue;
      const day = String(row.date).slice(0, 10);
      points.push({ day, price: close, ts: new Date(`${day}T12:00:00Z`).getTime() });
    }
    if (points.length) return parsePointsFromDays(points);
  }
  throw new Error(data?.['Error Message'] || data?.message || 'FMP returned no rows');
}

async function fetchFmpHistory(ticker, apiKey, years = 10) {
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const from = formatDay(start);
  const url = new URL('https://financialmodelingprep.com/stable/historical-price-eod/light');
  url.searchParams.set('symbol', ticker);
  url.searchParams.set('from', from);
  url.searchParams.set('apikey', apiKey);

  const res = await fetch(url);
  const text = await res.text();
  if (res.status === 402 || res.status === 403) {
    throw new Error(`FMP ${ticker} not on free plan (HTTP ${res.status})`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`FMP HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  if (!res.ok) throw new Error(data?.['Error Message'] || `FMP HTTP ${res.status}`);
  return parseFmpRows(data);
}

async function fetchFmpQuote(ticker, apiKey) {
  const url = `https://financialmodelingprep.com/stable/quote?symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (res.status === 402 || res.status === 403) {
    throw new Error(`FMP quote ${ticker} not on free plan`);
  }
  const data = JSON.parse(text);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.price) throw new Error(`${ticker} no FMP quote`);
  return {
    price: Number(row.price),
    currency: row.currency || 'ZAR',
    change_pct: row.changesPercentage != null ? Number(row.changesPercentage) : null,
  };
}

function parseYahooChart(data, ticker) {
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo ${ticker} no chart result`);
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    const day = formatDay(timestamps[i] * 1000);
    points.push({ day, price: closes[i], ts: timestamps[i] * 1000 });
  }
  if (!points.length) throw new Error(`Yahoo ${ticker} no close prices`);
  return parsePointsFromDays(points);
}

async function fetchYahooHistory(ticker, range = '10y', { retries = 2 } = {}) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${encodeURIComponent(range)}&interval=1d`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json,text/plain,*/*',
    Origin: 'https://finance.yahoo.com',
    Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}`,
  };

  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    const gap = Date.now() - lastYahooMs;
    if (gap < YAHOO_GAP_MS) await sleep(YAHOO_GAP_MS - gap);
    lastYahooMs = Date.now();

    const res = await fetch(url, { headers });
    if (res.status === 429) {
      lastErr = new Error(`Yahoo ${ticker} HTTP 429`);
      await sleep(YAHOO_429_WAIT_MS * (attempt + 1));
      continue;
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Yahoo ${ticker} non-JSON HTTP ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`Yahoo ${ticker} HTTP ${res.status}`);
    }
    return parseYahooChart(data, ticker);
  }
  throw lastErr || new Error(`Yahoo ${ticker} failed after ${retries} tries`);
}

async function fetchYahooQuote(ticker) {
  const points = await fetchYahooHistory(ticker, '5d', { retries: 3 });
  const latest = points[points.length - 1];
  const prior = points[points.length - 2];
  return {
    price: latest.price,
    currency: 'ZAR',
    change_pct: prior ? ((latest.price - prior.price) / prior.price) * 100 : null,
  };
}

function mergeHistory(primary, extra) {
  const byDay = new Map(primary.map((p) => [p.day, p]));
  for (const p of extra) {
    if (!byDay.has(p.day)) byDay.set(p.day, p);
  }
  return parsePointsFromDays([...byDay.values()]);
}

/**
 * Daily closes for a JSE ticker (e.g. IMP.JO).
 */
export async function fetchJseDailyHistory(ticker, { years = 10 } = {}) {
  const range = years <= 2 ? '2y' : years <= 5 ? '5y' : '10y';

  try {
    let points = await fetchYahooHistory(ticker, range);
    for (const alt of HISTORY_ALIASES[ticker] || []) {
      try {
        points = mergeHistory(points, await fetchYahooHistory(alt, range));
      } catch (_) {}
    }
    if (points.length) return { points, source: 'yahoo-finance' };
  } catch (err) {
    console.warn(`[jse-history] Yahoo ${ticker}: ${err.message}`);
  }

  const fmpKey = process.env.FMP_API_KEY;
  if (fmpKey) {
    try {
      let points = await fetchFmpHistory(ticker, fmpKey, years);
      for (const alt of HISTORY_ALIASES[ticker] || []) {
        try {
          points = mergeHistory(points, await fetchFmpHistory(alt, fmpKey, years));
          await sleep(400);
        } catch (_) {}
      }
      if (points.length) return { points, source: 'fmp' };
    } catch (err) {
      console.warn(`[jse-history] FMP ${ticker}: ${err.message}`);
    }
  }

  throw new Error(
    `No JSE history for ${ticker}. Yahoo may be rate-limited — wait 15 min and re-run, or upgrade FMP for international.`
  );
}

export async function fetchJseLatestQuote(ticker) {
  try {
    return { ...(await fetchYahooQuote(ticker)), source: 'yahoo-finance' };
  } catch (err) {
    console.warn(`[jse-history] Yahoo quote ${ticker}: ${err.message}`);
  }

  const fmpKey = process.env.FMP_API_KEY;
  if (fmpKey) {
    try {
      return { ...(await fetchFmpQuote(ticker, fmpKey)), source: 'fmp' };
    } catch (err) {
      console.warn(`[jse-history] FMP quote ${ticker}: ${err.message}`);
    }
  }

  throw new Error(`No JSE quote for ${ticker}.`);
}
