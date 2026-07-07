// netlify/functions/fetch-producer-intraday.js
//
// Scheduled ingest (hourly) — pulls intraday OHLCV bars for JSE platinum producers
// from EODHD and upserts them into Supabase `producer_price_intraday`.
//
// Env vars (Netlify):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   EODHD_API_TOKEN

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EODHD_API_TOKEN = process.env.EODHD_API_TOKEN;

const PRODUCERS = [
  // Store tickers as Yahoo-style for UI consistency, but query EODHD using JSE codes.
  { ticker: 'VAL.JO', eod: 'VAL.JSE', name: 'Valterra Platinum' },
  { ticker: 'IMP.JO', eod: 'IMP.JSE', name: 'Impala Platinum' },
  { ticker: 'SSW.JO', eod: 'SSW.JSE', name: 'Sibanye-Stillwater' },
  { ticker: 'NPH.JO', eod: 'NPH.JSE', name: 'Northam Platinum' },
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

async function eodhdIntraday(eodTicker, { fromUnix, toUnix, interval = '1h' }) {

  const url =
    `https://eodhd.com/api/intraday/${encodeURIComponent(eodTicker)}` +
    `?api_token=${encodeURIComponent(EODHD_API_TOKEN)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&fmt=json` +
    (fromUnix ? `&from=${fromUnix}` : '') +
    (toUnix ? `&to=${toUnix}` : '');

  const res = await fetch(url, { headers: { 'User-Agent': 'PlatinumMetisBot/3.0' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`EODHD ${eodTicker} intraday failed: ${res.status} ${text.slice(0, 160)}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`EODHD ${eodTicker} intraday empty`);
  return rows;
}

async function eodhdRealtime(eodTicker) {
  const url =
    `https://eodhd.com/api/real-time/${encodeURIComponent(eodTicker)}` +
    `?api_token=${encodeURIComponent(EODHD_API_TOKEN)}` +
    `&fmt=json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'PlatinumMetisBot/3.0' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`EODHD ${eodTicker} real-time failed: ${res.status} ${text.slice(0, 160)}`);
  }
  const q = await res.json();
  const close = Number(q?.close);
  if (!Number.isFinite(close)) throw new Error(`EODHD ${eodTicker} real-time missing close`);
  return {
    datetime: new Date().toISOString(),
    open: close,
    high: close,
    low: close,
    close,
    volume: null,
  };
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
        source: 'eodhd.com',
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
    source: 'eodhd.com',
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
  if (!EODHD_API_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing EODHD_API_TOKEN' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Backfill window: last 10 days hourly. (Over-fetching is ok; unique index + ignore-duplicates.)
  const now = Math.floor(Date.now() / 1000);
  const fromUnix = now - 10 * 24 * 3600;

  const out = [];
  for (const p of PRODUCERS) {
    const ticker = p.ticker;
    try {
      let bars = null;
      let mode = 'intraday';
      try {
        bars = await eodhdIntraday(p.eod, { fromUnix, toUnix: now, interval: '1h' });
      } catch (err) {
        if (String(err.message || '').includes('intraday empty')) {
          mode = 'realtime-sample';
          bars = [await eodhdRealtime(p.eod)];
        } else {
          throw err;
        }
      }

      const ins = await upsertIntradayRows(ticker, bars);
      const q = await upsertLatestQuote(ticker, p.name, bars);
      out.push({ ticker, eod: p.eod, ok: true, mode, bars: bars.length, inserted: ins.inserted, quote: q.ok });
    } catch (err) {
      console.error(ticker, err.message);
      out.push({ ticker, eod: p.eod, ok: false, error: err.message });
    }
    await new Promise((r) => setTimeout(r, 350));
  }

  return new Response(JSON.stringify({ ok: true, results: out }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

