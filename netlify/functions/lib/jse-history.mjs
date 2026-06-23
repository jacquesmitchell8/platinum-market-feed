/**
 * JSE producer daily history — Twelve Data (primary) + FMP (fallback).
 * Yahoo Finance rate-limits server/automation traffic; these sources are reliable for JSE.
 *
 * Env: TWELVE_DATA_API_KEY (free at https://twelvedata.com/pricing)
 *      FMP_API_KEY (optional fallback at https://financialmodelingprep.com/developer/docs)
 */

export const PRODUCER_TICKERS = ['VAL.JO', 'IMP.JO', 'SSW.JO', 'NPH.JO'];

const TICKER_TO_JSE = {
  'VAL.JO': 'VAL',
  'IMP.JO': 'IMP',
  'SSW.JO': 'SSW',
  'NPH.JO': 'NPH',
};

function formatDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function jseCode(ticker) {
  return TICKER_TO_JSE[ticker] || ticker.replace(/\.JO$/i, '');
}

function parseTwelveDataSeries(data) {
  const values = data?.values;
  if (!Array.isArray(values) || !values.length) {
    throw new Error(data?.message || 'Twelve Data returned no values');
  }
  const points = [];
  for (const row of values) {
    const close = row.close != null ? Number(row.close) : null;
    if (close == null || Number.isNaN(close)) continue;
    const day = String(row.datetime).slice(0, 10);
    points.push({ day, price: close, ts: new Date(`${day}T12:00:00Z`).getTime() });
  }
  points.sort((a, b) => a.day.localeCompare(b.day));
  return points;
}

async function fetchTwelveDataHistory(ticker, apiKey, years = 10) {
  const code = jseCode(ticker);
  const end = formatDay(Date.now());
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const startDay = formatDay(start);

  const attempts = [
    { symbol: code, exchange: 'JSE' },
    { symbol: `${code}:JSE` },
    { symbol: code, exchange: 'XJSE' },
  ];

  let lastErr;
  for (const params of attempts) {
    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('interval', '1day');
    url.searchParams.set('outputsize', '5000');
    url.searchParams.set('start_date', startDay);
    url.searchParams.set('end_date', end);
    url.searchParams.set('apikey', apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || data?.status === 'error') {
      lastErr = new Error(data?.message || `Twelve Data HTTP ${res.status}`);
      continue;
    }
    try {
      return parseTwelveDataSeries(data);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`Twelve Data ${ticker} failed`);
}

async function fetchTwelveDataQuote(ticker, apiKey) {
  const code = jseCode(ticker);
  const attempts = [
    { symbol: code, exchange: 'JSE' },
    { symbol: `${code}:JSE` },
    { symbol: code, exchange: 'XJSE' },
  ];

  let lastErr;
  for (const params of attempts) {
    const url = new URL('https://api.twelvedata.com/quote');
    url.searchParams.set('apikey', apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || data?.status === 'error') {
      lastErr = new Error(data?.message || `Twelve Data quote HTTP ${res.status}`);
      continue;
    }
    const price = data.close != null ? Number(data.close) : Number(data.price);
    if (price == null || Number.isNaN(price)) {
      lastErr = new Error(`${ticker} no quote price`);
      continue;
    }
    return {
      price,
      currency: data.currency || 'ZAR',
      change_pct: data.percent_change != null ? Number(data.percent_change) : null,
    };
  }
  throw lastErr || new Error(`Twelve Data quote ${ticker} failed`);
}

function parseFmpHistory(data) {
  const hist = data?.historical;
  if (!Array.isArray(hist) || !hist.length) throw new Error('FMP returned no historical rows');
  const points = [];
  for (const row of hist) {
    const close = row.close != null ? Number(row.close) : null;
    if (close == null || Number.isNaN(close)) continue;
    const day = String(row.date).slice(0, 10);
    points.push({ day, price: close, ts: new Date(`${day}T12:00:00Z`).getTime() });
  }
  points.sort((a, b) => a.day.localeCompare(b.day));
  return points;
}

async function fetchFmpHistory(ticker, apiKey) {
  const url = `https://financialmodelingprep.com/api/v3/historical-price-full/${encodeURIComponent(ticker)}?apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(`FMP HTTP ${res.status}`);
  if (data?.['Error Message']) throw new Error(data['Error Message']);
  return parseFmpHistory(data);
}

async function fetchFmpQuote(ticker, apiKey) {
  const url = `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(ticker)}?apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(`FMP quote HTTP ${res.status}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.price) throw new Error(`${ticker} no FMP quote`);
  return {
    price: Number(row.price),
    currency: 'ZAR',
    change_pct: row.changesPercentage != null ? Number(row.changesPercentage) : null,
  };
}

/**
 * Daily OHLCV closes for a JSE ticker (e.g. IMP.JO).
 * @returns {{ points: {day:string, price:number, ts:number}[], source: string }}
 */
export async function fetchJseDailyHistory(ticker, { years = 10 } = {}) {
  const twelveKey = process.env.TWELVE_DATA_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;

  if (twelveKey) {
    try {
      const points = await fetchTwelveDataHistory(ticker, twelveKey, years);
      if (points.length) return { points, source: 'twelve-data' };
    } catch (err) {
      console.warn(`[jse-history] Twelve Data ${ticker}: ${err.message}`);
    }
  }

  if (fmpKey) {
    try {
      const points = await fetchFmpHistory(ticker, fmpKey);
      if (points.length) return { points, source: 'fmp' };
    } catch (err) {
      console.warn(`[jse-history] FMP ${ticker}: ${err.message}`);
    }
  }

  throw new Error(
    `No JSE history for ${ticker}. Set TWELVE_DATA_API_KEY (free) or FMP_API_KEY in Netlify / .env.seed`
  );
}

/** Latest quote for dashboards / scheduled refresh. */
export async function fetchJseLatestQuote(ticker) {
  const twelveKey = process.env.TWELVE_DATA_API_KEY;
  const fmpKey = process.env.FMP_API_KEY;

  if (twelveKey) {
    try {
      return { ...(await fetchTwelveDataQuote(ticker, twelveKey)), source: 'twelve-data' };
    } catch (err) {
      console.warn(`[jse-history] Twelve Data quote ${ticker}: ${err.message}`);
    }
  }

  if (fmpKey) {
    try {
      return { ...(await fetchFmpQuote(ticker, fmpKey)), source: 'fmp' };
    } catch (err) {
      console.warn(`[jse-history] FMP quote ${ticker}: ${err.message}`);
    }
  }

  throw new Error(`No JSE quote for ${ticker}. Set TWELVE_DATA_API_KEY or FMP_API_KEY`);
}
