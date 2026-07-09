// netlify/functions/fetch-producer-intraday.js
//
// Scheduled ingest (hourly) — pulls intraday OHLCV bars for JSE platinum producers
// from Yahoo Finance v8 chart endpoint and upserts them into Supabase
// `producer_price_intraday`.
//
// Env vars (Netlify):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PRODUCERS = [
  { ticker: 'VAL.JO', name: 'Valterra Platinum' },
  { ticker: 'IMP.JO', name: 'Impala Platinum' },
  { ticker: 'SSW.JO', name: 'Sibanye-Stillwater' },
  { ticker: 'NPH.JO', name: 'Northam Platinum' },
];

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

function pctChg(cur, prev) {
  if (cur == null || prev == null || !prev) return null;
  return ((cur - prev) / prev) * 100;
}

function yahooChartUrl(ticker, { range = '5d', interval = '60m', includePrePost = false } = {}) {
  const base = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`;
  const params = new URLSearchParams();
  params.set('range', range);
  params.set('interval', interval);
  params.set('includePrePost', includePrePost ? 'true' : 'false');
  params.set('events', 'div%7Csplits'); // keep response small but consistent
  return `${base}?${params.toString()}`;
}

function parseYahooBars(json) {
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo: missing result');
  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const opens = q.open || [];
  const highs = q.high || [];
  const lows = q.low || [];
  const closes = q.close || [];
  const vols = q.volume || [];
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const close = closes[i];
    if (ts == null || close == null) continue;
    bars.push({
      datetime: new Date(ts * 1000).toISOString(),
      open: opens[i],
      high: highs[i],
      low: lows[i],
      close,
      volume: vols[i],
    });
  }
  if (!bars.length) throw new Error('Yahoo: empty bars');
  return bars;
}

async function yahooIntradayBars(ticker, { range = '5d', interval = '60m' } = {}) {
  const url = yahooChartUrl(ticker, { range, interval, includePrePost: false });
  const headers = {
    // A normal browser UA tends to reduce bot-blocking.
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
    Accept: 'application/json,text/plain,*/*',
  };

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) {
      const json = await res.json();
      if (json?.chart?.error) throw new Error(`Yahoo ${ticker}: ${json.chart.error.description || 'error'}`);
      return parseYahooBars(json);
    }

    const text = await res.text().catch(() => '');
    if (res.status === 429 && attempt < maxAttempts) {
      // Backoff with jitter to reduce lockouts.
      const waitMs = (800 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 600);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`Yahoo ${ticker} chart failed: ${res.status} ${text.slice(0, 160)}`);
  }
  throw new Error(`Yahoo ${ticker} chart failed: exhausted retries`);
}

async function upsertIntradayRows(ticker, bars) {
  // EODHD returns UTC datetime strings.
  const rows = bars
    .map((b) => {
      const recordedAt = b.datetime ? new Date(b.datetime).toISOString() : null;
      const close = Number(b.close);
      if (!recordedAt || !Number.isFinite(close)) return null;
      return {
        ticker,
        interval_min: 60,
        recorded_at: recordedAt,
        open: b.open != null ? Number(b.open) : null,
        high: b.high != null ? Number(b.high) : null,
        low: b.low != null ? Number(b.low) : null,
        close,
        volume: b.volume != null ? Number(b.volume) : null,
        source: 'yahoo-finance',
      };
    })
    .filter(Boolean);

  if (!rows.length) return { inserted: 0 };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/producer_price_intraday`, {
    method: 'POST',
    headers: {
      ...sbHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase intraday insert ${ticker}: ${res.status} ${text.slice(0, 160)}`);
  }
  return { inserted: rows.length };
}

async function upsertLatestQuote(ticker, name, bars) {
  const last = bars[bars.length - 1];
  const prior = bars.length >= 2 ? bars[bars.length - 2] : null;
  const price = last?.close != null ? Number(last.close) : null;
  const prev = prior?.close != null ? Number(prior.close) : null;
  if (!Number.isFinite(price)) return { ok: false };

  const updatedAt = last?.datetime ? new Date(last.datetime).toISOString() : new Date().toISOString();
  const payload = {
    ticker,
    name,
    price,
    currency: 'ZAR',
    change_pct: prev != null && Number.isFinite(prev) ? pctChg(price, prev) : null,
    updated_at: updatedAt,
    source: 'yahoo-finance',
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/producer_quotes`, {
    method: 'POST',
    headers: {
      ...sbHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase quote upsert ${ticker}: ${res.status} ${text.slice(0, 160)}`);
  }
  return { ok: true };
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const out = [];
  for (const p of PRODUCERS) {
    const ticker = p.ticker;
    try {
      // 5 trading days @ 1h gives us enough density for 24h/1w views.
      const bars = await yahooIntradayBars(ticker, { range: '5d', interval: '60m' });

      const ins = await upsertIntradayRows(ticker, bars);
      const q = await upsertLatestQuote(ticker, p.name, bars);
      out.push({ ticker, ok: true, bars: bars.length, inserted: ins.inserted, quote: q.ok });
    } catch (err) {
      console.error(ticker, err.message);
      out.push({ ticker, ok: false, error: err.message });
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  return new Response(JSON.stringify({ ok: true, results: out }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

