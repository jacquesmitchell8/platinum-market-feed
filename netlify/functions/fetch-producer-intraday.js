// netlify/functions/fetch-producer-intraday.js
//
// Scheduled ingest (hourly) — pulls intraday OHLCV bars for JSE platinum producers
// from Sharenet intraday chart data and upserts them into Supabase
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

async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
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

async function sharenetChart1dPoints(shareCode) {
  const url = `https://www.sharenet.co.za/jse/${encodeURIComponent(shareCode)}/`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  }, 9000);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sharenet ${shareCode} page failed: ${res.status} ${text.slice(0, 140)}`);
  }
  const html = await res.text();
  // The page embeds `var chart1d = [ [<ms>,<priceCents>], ... ];`
  const m = html.match(/var\s+chart1d\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error(`Sharenet ${shareCode}: missing chart1d`);
  const raw = m[1];
  // Parse pairs like [1783580400000,17141] and ignore nulls.
  const pts = [];
  const re = /\[\s*(\d{12,})\s*,\s*([0-9.]+|null)\s*\]/g;
  let hit;
  while ((hit = re.exec(raw))) {
    const ts = Number(hit[1]);
    const v = hit[2] === 'null' ? null : Number(hit[2]);
    if (!Number.isFinite(ts) || v == null || !Number.isFinite(v)) continue;
    // Sharenet uses cents for JSE shares; store in ZAR.
    pts.push({ ts, price: v / 100 });
  }
  if (!pts.length) throw new Error(`Sharenet ${shareCode}: chart1d empty`);
  return pts;
}

function toBucketBars(points, bucketMs) {
  const byBucket = new Map();
  for (const p of points) {
    const bucket = Math.floor(p.ts / bucketMs) * bucketMs;
    const prev = byBucket.get(bucket);
    if (!prev || p.ts >= prev.ts) byBucket.set(bucket, p);
  }
  return [...byBucket.keys()].sort((a, b) => a - b).map((h) => {
    const p = byBucket.get(h);
    return {
      datetime: new Date(h).toISOString(),
      open: p.price,
      high: p.price,
      low: p.price,
      close: p.price,
      volume: null,
    };
  });
}

function toHourlyBars(points) {
  return toBucketBars(points, 3600000);
}

function zarFromYahoo(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const n = Number(value);
  // JSE Yahoo charts often quote in ZAc (cents).
  if (currency === 'ZAc' || currency === 'GBp') return n / 100;
  return n;
}

function parseYahooBars(json) {
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo: missing result');
  const currency = result.meta?.currency || 'ZAR';
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
    const close = zarFromYahoo(closes[i], currency);
    if (ts == null || close == null) continue;
    bars.push({
      datetime: new Date(ts * 1000).toISOString(),
      open: zarFromYahoo(opens[i], currency),
      high: zarFromYahoo(highs[i], currency),
      low: zarFromYahoo(lows[i], currency),
      close,
      volume: vols[i],
      currency: currency === 'ZAc' ? 'ZAR' : currency,
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
    const res = await fetchWithTimeout(url, { headers }, 8000);
    if (res.ok) {
      const json = await res.json();
      if (json?.chart?.error) throw new Error(`Yahoo ${ticker}: ${json.chart.error.description || 'error'}`);
      return parseYahooBars(json);
    }

    const text = await res.text().catch(() => '');
    if (res.status === 429 && attempt < maxAttempts) {
      // Backoff with jitter to reduce lockouts.
      const waitMs = (500 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 400);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`Yahoo ${ticker} chart failed: ${res.status} ${text.slice(0, 160)}`);
  }
  throw new Error(`Yahoo ${ticker} chart failed: exhausted retries`);
}

async function upsertIntradayRows(ticker, bars, intervalMin = 60, source = 'sharenet') {
  const rows = bars
    .map((b) => {
      const recordedAt = b.datetime ? new Date(b.datetime).toISOString() : null;
      const close = Number(b.close);
      if (!recordedAt || !Number.isFinite(close)) return null;
      return {
        ticker,
        interval_min: intervalMin,
        recorded_at: recordedAt,
        open: b.open != null ? Number(b.open) : null,
        high: b.high != null ? Number(b.high) : null,
        low: b.low != null ? Number(b.low) : null,
        close,
        volume: b.volume != null ? Number(b.volume) : null,
        source,
      };
    })
    .filter(Boolean);

  if (!rows.length) return { inserted: 0 };

  // Batch — Sharenet session can be 400+ prints.
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/producer_price_intraday?on_conflict=ticker%2Cinterval_min%2Crecorded_at`,
      {
        method: 'POST',
        headers: {
          ...sbHeaders(),
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify(batch),
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase intraday insert ${ticker}: ${res.status} ${text.slice(0, 160)}`);
    }
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

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const all = url.searchParams.get('all') === '1';
  // One ticker per scheduled run; ?all=1 backfills every name (deploy / manual).
  const list = all
    ? PRODUCERS
    : [PRODUCERS[Math.floor(Date.now() / 3600000) % PRODUCERS.length]];
  const out = [];

  for (const p of list) {
    const ticker = p.ticker;
    try {
      const shareCode = ticker.split('.')[0];
      const pts = await sharenetChart1dPoints(shareCode);
      const dense = toBucketBars(pts, 5 * 60000);
      const hourly = toBucketBars(pts, 3600000);
      const ins5 = await upsertIntradayRows(ticker, dense, 5, 'sharenet-5m');
      const ins60 = await upsertIntradayRows(ticker, hourly, 60, 'sharenet-1h');
      const q = await upsertLatestQuote(ticker, p.name, dense.length ? dense : hourly);
      out.push({
        ticker,
        ok: true,
        source: 'sharenet-1d',
        dense: dense.length,
        hourly: hourly.length,
        inserted5: ins5.inserted,
        inserted60: ins60.inserted,
        quote: q.ok,
      });
    } catch (err) {
      console.error(ticker, err.message);
      try {
        const site = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://platinum-conflux.netlify.app';
        const proxyUrl = `${site.replace(/\/$/, '')}/yahoo-proxy/v8/finance/chart/${encodeURIComponent(ticker)}?range=1mo&interval=60m`;
        const res = await fetchWithTimeout(proxyUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/2.0)' },
        }, 12000);
        if (!res.ok) throw new Error(`yahoo-proxy ${res.status}`);
        const bars = parseYahooBars(await res.json());
        const ins = await upsertIntradayRows(ticker, bars, 60, 'yahoo-proxy-1mo');
        const q = await upsertLatestQuote(ticker, p.name, bars);
        out.push({ ticker, ok: true, source: 'yahoo-proxy-1mo', bars: bars.length, inserted: ins.inserted, quote: q.ok });
      } catch (inner) {
        out.push({ ticker, ok: false, error: err.message, fallbackError: inner.message });
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, results: out }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

