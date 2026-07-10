// Load bundled producer history JSON and map to Supabase rows.
import fs from 'fs';
import path from 'path';

const TICKERS = ['VAL.JO', 'IMP.JO', 'SSW.JO', 'NPH.JO'];

const JSON_PATHS = [
  path.join(process.cwd(), 'data', 'producer-jse-history.json'),
  path.join(process.cwd(), '..', 'data', 'producer-jse-history.json'),
];

export async function loadProducerHistoryJson() {
  for (const p of JSON_PATHS) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (_) {}
  }

  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://platinum-conflux.netlify.app';
  const res = await fetch(`${base.replace(/\/$/, '')}/data/producer-jse-history.json`);
  if (!res.ok) throw new Error(`producer-jse-history.json HTTP ${res.status}`);
  return res.json();
}

export function staticPointsForTicker(data, ticker) {
  const series = data?.series || {};
  const hit = Object.values(series).find((s) => s?.ticker === ticker);
  return hit?.points || [];
}

export function pointsToRows(ticker, points) {
  return points.map((p) => ({
    ticker,
    price: p.price,
    recorded_at: `${p.day}T12:00:00Z`,
    recorded_day: p.day,
  }));
}

export { TICKERS };
