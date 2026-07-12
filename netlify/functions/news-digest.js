// netlify/functions/news-digest.js
//
// Fast read endpoint for the news panel. Full RSS + Google News ingest runs on
// fetch-news (every ~3h) or when the UI Refresh button hits that function.
// ?refresh=1 here only does a light feed top-up for backwards compatibility.

import { pickTopStories, buildProgression, dedupeStories, normTitleForExport } from './lib/news-enrich.mjs';
import { researchStory, buildDailyBrief } from './lib/news-research.mjs';
import { parseRssItems } from './lib/rss-utils.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FEEDS = [
  { url: 'https://www.businesstimes.com.sg/rss/feed/bt_commodities', source: 'Business Times Singapore', topic: 'platinum' },
  { url: 'https://www.scmp.com/rss/91/feed', source: 'South China Morning Post', topic: 'macro' },
  { url: 'https://www.moneyweb.co.za/feed/', source: 'Moneyweb', topic: 'producers' },
  { url: 'https://www.mining.com/feed/', source: 'Mining.com', topic: 'platinum' },
  { url: 'https://www.kitco.com/news/rss/news.xml', source: 'Kitco Metals', topic: 'platinum' },
  { url: 'https://www.investing.com/rss/news_285.rss', source: 'Investing.com · Platinum', topic: 'platinum' },
];

function digestDateSydney() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/2.0)' },
  });
  if (!res.ok) throw new Error(`${feed.topic} fetch failed: ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, 25).map((item) => ({
    ...item,
    source: item.publisher || feed.source || item.source || 'RSS',
    topic: feed.topic,
  }));
}

async function upsertStoriesBatch(stories) {
  if (!stories.length) return 0;
  const payload = stories.map((story) => ({
    title: story.title,
    url: story.url,
    source: story.source,
    topic: story.topic,
    published_at: story.published_at,
    fetched_at: new Date().toISOString(),
    title_norm: normTitleForExport(story.title),
  }));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/news_stories?on_conflict=url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=ignore-duplicates',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('news batch upsert:', res.status, text.slice(0, 200));
    return 0;
  }
  return payload.length;
}

async function refreshNewsFromFeeds() {
  const results = await Promise.allSettled(FEEDS.map((feed) => fetchFeed(feed)));
  const allItems = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allItems.push(...r.value);
    else console.error('Feed error:', r.reason?.message);
  }
  const unique = dedupeStories(allItems);
  return upsertStoriesBatch(unique);
}

async function deepResearchTopStories(top) {
  const results = await Promise.allSettled(
    top.map((s) => researchStory({
      headline: s.title,
      title: s.title,
      url: s.url,
      topic: s.topic,
      source: s.source,
      publishedAt: s.published_at,
    }, { maxArticles: 12, perQuery: 8 }))
  );
  return results.map((r) => (r.status === 'fulfilled' ? r.value : null));
}

function mapStoryForClient(s, research = null) {
  return {
    title: s.title,
    headline: s.headline || s.title,
    url: s.url,
    source: s.source,
    topic: s.topic,
    publishedAt: s.published_at,
    rank: s.rank,
    bullets: s.bullets || [],
    platinumImpact: s.platinumImpact,
    direction: s.direction,
    themeLabels: s.themeLabels || [],
    relevanceScore: s.relevanceScore,
    research: research || s.research || null,
  };
}

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const deep = url.searchParams.get('deep') !== '0';
  const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('force') === '1';

  let refreshed = 0;
  if (refresh) {
    try {
      refreshed = await refreshNewsFromFeeds();
    } catch (err) {
      console.error('refreshNewsFromFeeds:', err.message);
    }
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/news_stories?select=title,url,source,topic,published_at,fetched_at&order=published_at.desc.nullslast,fetched_at.desc&limit=120`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (!res.ok) throw new Error(`Supabase read failed: ${res.status}`);
    const rows = await res.json();
    if (!rows.length) {
      return new Response(JSON.stringify({
        ok: false,
        error: refresh ? 'No news stories available yet — feeds may be rate-limited' : 'No news stories yet — tap Refresh',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { top, rest } = pickTopStories(rows, 3);
    const progression = buildProgression(top);

    let researches = [];
    if (deep) {
      researches = await deepResearchTopStories(top);
    }

    const dailyBrief = deep ? buildDailyBrief(top, researches) : null;
    const stories = top.map((s, i) => mapStoryForClient(s, researches[i]));
    const pastStories = rest.slice(0, 40).map((r) => ({
      ...mapStoryForClient(r),
      digestDate: (r.fetched_at || r.published_at || '').slice(0, 10),
    }));

    return new Response(JSON.stringify({
      ok: true,
      date: digestDateSydney(),
      stories,
      pastStories,
      progression,
      dailyBrief,
      deepResearched: deep,
      refreshed,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=900, stale-while-revalidate=1800',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
