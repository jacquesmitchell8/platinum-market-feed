// netlify/functions/ta-intelligence.js
//
// Serves TA pattern library + stores/returns per-detection event stories in Supabase.

import { TA_PATTERNS, patternBySlug, buildObservationStory } from './lib/ta-library.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function ensureLibrarySeeded() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ta_pattern_library?select=slug&limit=1`, {
    headers: sbHeaders(),
  });
  if (!res.ok) return;
  const rows = await res.json();
  if (rows.length >= TA_PATTERNS.length) return;

  for (const p of TA_PATTERNS) {
    await fetch(`${SUPABASE_URL}/rest/v1/ta_pattern_library`, {
      method: 'POST',
      headers: {
        ...sbHeaders(),
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        slug: p.slug,
        title: p.title,
        bias: p.bias,
        summary: p.summary,
        theory: p.theory,
        diagram: p.diagram,
        updated_at: new Date().toISOString(),
      }),
    });
  }
}

async function fetchLibrary() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/ta_pattern_library?select=slug,title,bias,summary,theory,diagram&order=slug.asc`,
    { headers: sbHeaders() }
  );
  if (!res.ok) throw new Error(`Library read failed: ${res.status}`);
  const rows = await res.json();
  if (rows.length) return rows;
  return TA_PATTERNS.map((p) => ({
    slug: p.slug,
    title: p.title,
    bias: p.bias,
    summary: p.summary,
    theory: p.theory,
    diagram: p.diagram,
  }));
}

async function fetchObservations(curveId, timeframe) {
  let path = `${SUPABASE_URL}/rest/v1/ta_observations?select=id,pattern_slug,curve_id,timeframe,fingerprint,event_start_ts,event_end_ts,story_narrative,story_sources,detected_at&order=detected_at.desc&limit=20`;
  if (curveId) path += `&curve_id=eq.${encodeURIComponent(curveId)}`;
  if (timeframe) path += `&timeframe=eq.${encodeURIComponent(timeframe)}`;
  const res = await fetch(path, { headers: sbHeaders() });
  if (!res.ok) return [];
  return res.json();
}

async function upsertObservation(payload) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ta_observations`, {
    method: 'POST',
    headers: {
      ...sbHeaders(),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Observation upsert failed: ${t.slice(0, 200)}`);
  }
  return payload;
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  try {
    await ensureLibrarySeeded();
  } catch (err) {
    console.warn('ensureLibrarySeeded:', err.message);
  }

  const url = new URL(req.url);

  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const pattern = patternBySlug(body.patternSlug);
      if (!pattern) {
        return new Response(JSON.stringify({ ok: false, error: 'Unknown pattern' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }
      const story = buildObservationStory(pattern, body.context || {});
      const row = {
        pattern_slug: body.patternSlug,
        curve_id: body.curveId || null,
        timeframe: body.timeframe || null,
        fingerprint: body.fingerprint,
        event_start_ts: body.eventStartTs || null,
        event_end_ts: body.eventEndTs || null,
        price_snapshot: body.priceSnapshot || null,
        story_narrative: story,
        story_sources: body.storySources || [{ label: 'Platinum Metis TA engine', type: 'internal' }],
        detected_at: new Date().toISOString(),
      };
      await upsertObservation(row);
      return new Response(JSON.stringify({ ok: true, observation: row }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }
  }

  const curveId = url.searchParams.get('curveId') || '';
  const timeframe = url.searchParams.get('timeframe') || '';

  try {
    const [library, observations] = await Promise.all([
      fetchLibrary(),
      fetchObservations(curveId, timeframe),
    ]);
    return new Response(JSON.stringify({ ok: true, library, observations }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=7200',
        ...CORS,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: true,
      library: TA_PATTERNS.map((p) => ({
        slug: p.slug,
        title: p.title,
        bias: p.bias,
        summary: p.summary,
        theory: p.theory,
        diagram: p.diagram,
      })),
      observations: [],
      fallback: true,
      error: err.message,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }
};
