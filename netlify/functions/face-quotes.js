// netlify/functions/face-quotes.js
// Persist / recall Face Value Scarcity dealer asks (manual price pad + history).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function upsertQuotes(quotes) {
  if (!quotes?.length) return 0;
  const payload = quotes.map((q) => ({
    id: q.id,
    recorded_at: q.recordedAt || q.recorded_at || new Date().toISOString(),
    seller: q.seller || null,
    coin: q.coin || q.name,
    value_aud: q.valueAud ?? q.value_aud ?? null,
    melt_aud: q.meltAud ?? q.melt_aud ?? null,
    premium_pct: q.premiumPct ?? q.premium_pct ?? null,
    recommendation: q.recommendation || null,
    scarcity_score: q.scarcityScore ?? q.scarcity_score ?? null,
    metal: q.metal || null,
    weight_oz: q.weightOz ?? q.weight_oz ?? null,
    source_file: q.sourceFile || q.source_file || null,
    batch_id: q.batchId || q.batch_id || null,
    reasoning: q.reasoning || null,
  }));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/face_coin_quotes?on_conflict=id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upsert ${res.status}: ${text.slice(0, 160)}`);
  }
  return payload.length;
}

async function listQuotes({ all = false, limit = 500 } = {}) {
  let path =
    `face_coin_quotes?select=*&order=recorded_at.desc&limit=${Math.min(Number(limit) || 500, 2000)}`;
  if (!all) {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    path += `&recorded_at=gte.${encodeURIComponent(since)}`;
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`List ${res.status}: ${text.slice(0, 160)}`);
  }
  return res.json();
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: cors });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { ok: false, error: 'Missing Supabase env' });
  }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const all = url.searchParams.get('all') === '1';
      const rows = await listQuotes({ all, limit: url.searchParams.get('limit') || 500 });
      return json(200, { ok: true, rows, count: rows.length, all });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const quotes = Array.isArray(body.quotes) ? body.quotes : [];
      if (!quotes.length) return json(400, { ok: false, error: 'No quotes' });
      const n = await upsertQuotes(quotes.slice(0, 400));
      return json(200, { ok: true, upserted: n });
    }

    return json(405, { ok: false, error: 'Method not allowed' });
  } catch (err) {
    return json(200, { ok: false, error: err.message || 'face-quotes failed' });
  }
};
