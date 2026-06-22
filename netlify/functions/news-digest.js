// netlify/functions/news-digest.js
//
// On-demand function (not scheduled) — called by the dashboard's NewsPanel.
// Reads the latest headlines written by the fetch-news scheduled function
// (Mining.com + Kitco RSS, twice daily) and returns today's top stories in
// the shape the dashboard expects.
//
// NOTE: this is real headlines/links/dates only — no AI sentiment scoring,
// relevance ranking, or "progression" analysis. Those fields are optional
// in the dashboard's rendering and will simply not show if absent.
//
// Required Netlify env vars:
//   SUPABASE_URL              -> <your Supabase project URL>
//   SUPABASE_ANON_KEY         -> publishable/anon key (read-only, safe to use here)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

function digestDateUTC() {
  return new Date().toISOString().slice(0, 10);
}

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Most recent 30 stories across all topics, newest first
    const url = `${SUPABASE_URL}/rest/v1/news_stories?select=title,url,source,topic,published_at,fetched_at&order=fetched_at.desc&limit=30`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`);
    const rows = await res.json();

    if (!rows.length) {
      return new Response(JSON.stringify({ ok: false, error: 'No news stories available yet' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Top 3 most recent as the "Daily Top 3" headline stories; rest go to past stories
    const topStories = rows.slice(0, 3).map((r, i) => ({
      title: r.title,
      url: r.url,
      source: r.source,
      publishedAt: r.published_at,
      rank: i + 1,
    }));

    const pastStories = rows.slice(3).map((r) => ({
      title: r.title,
      url: r.url,
      source: r.source,
      publishedAt: r.published_at,
      digestDate: (r.fetched_at || '').slice(0, 10),
    }));

    return new Response(JSON.stringify({
      ok: true,
      date: digestDateUTC(),
      stories: topStories,
      pastStories,
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
