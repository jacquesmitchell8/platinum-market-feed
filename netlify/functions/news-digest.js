// netlify/functions/news-digest.js
//
// Fetches PGM-focused Google News RSS, dedupes, scores direction, deep-researches top 3,
// returns daily brief with web-wide progression.

import { pickTopStories, buildProgression } from './lib/news-enrich.mjs';
import { researchStory, buildDailyBrief } from './lib/news-research.mjs';
import { parseRssItems } from './lib/rss-utils.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FEEDS = [
  { url: 'https://news.google.com/rss/search?q=platinum+mining+OR+platinum+deficit+OR+WPIC&hl=en-AU&gl=AU&ceid=AU:en', topic: 'platinum' },
  { url: 'https://news.google.com/rss/search?q=Impala+Platinum+OR+Sibanye+Stillwater+OR+Northam+Platinum+OR+Valterra+Platinum&hl=en-AU&gl=AU&ceid=AU:en', topic: 'producers' },
  { url: 'https://news.google.com/rss/search?q=palladium+rhodium+PGM+market&hl=en-AU&gl=AU&ceid=AU:en', topic: 'palladium' },
  { url: 'https://news.google.com/rss/search?q=platinum+price+LBMA+OR+spot+platinum&hl=en-AU&gl=AU&ceid=AU:en', topic: 'platinum' },
  { url: 'https://news.google.com/rss/search?q=hydrogen+platinum+fuel+cell+PGM&hl=en-AU&gl=AU&ceid=AU:en', topic: 'demand' },
  { url: 'https://news.google.com/rss/search?q=South+Africa+PGM+mining+strike+OR+Eskom&hl=en-AU&gl=AU&ceid=AU:en', topic: 'producers' },
];

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/2.0)' },
  });
  if (!res.ok) throw new Error(`${feed.topic} fetch failed: ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, 25).map((item) => ({
    ...item,
    source: item.publisher || item.source || 'Google News',
    topic: feed.topic,
  }));
}

async function upsertStory(story) {
  const url = `${SUPABASE_URL}/rest/v1/news_stories`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=ignore-duplicates',
    },
    body: JSON.stringify({
      title: story.title,
      url: story.url,
      source: story.source,
      topic: story.topic,
      published_at: story.published_at,
      fetched_at: new Date().toISOString(),
    }),
  });
  return res.ok;
}

async function refreshNewsFromFeeds() {
  for (const feed of FEEDS) {
    try {
      const items = await fetchFeed(feed);
      for (const item of items) {
        await upsertStory(item);
      }
    } catch (err) {
      console.error(`Feed ${feed.topic}: ${err.message}`);
    }
  }
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

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const deep = url.searchParams.get('deep') !== '0';

  try {
    await refreshNewsFromFeeds();
  } catch (err) {
    console.error('refreshNewsFromFeeds:', err.message);
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/news_stories?select=title,url,source,topic,published_at,fetched_at&order=published_at.desc.nullslast&limit=120`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (!res.ok) throw new Error(`Supabase read failed: ${res.status}`);
    const rows = await res.json();
    if (!rows.length) {
      return new Response(JSON.stringify({ ok: false, error: 'No news stories available yet' }), {
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
      digestDate: (r.fetched_at || '').slice(0, 10),
    }));

    return new Response(JSON.stringify({
      ok: true,
      date: new Date().toISOString().slice(0, 10),
      stories,
      pastStories,
      progression,
      dailyBrief,
      deepResearched: deep,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=1800, stale-while-revalidate=3600',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
