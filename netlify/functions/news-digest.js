// netlify/functions/news-digest.js
//
// Fetches PGM-focused Google News RSS, dedupes, scores direction, returns top 3 + progression.

import { pickTopStories, buildProgression } from './lib/news-enrich.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FEEDS = [
  { url: 'https://news.google.com/rss/search?q=platinum+mining+OR+platinum+deficit+OR+WPIC&hl=en-AU&gl=AU&ceid=AU:en', topic: 'platinum' },
  { url: 'https://news.google.com/rss/search?q=Impala+Platinum+OR+Sibanye+Stillwater+OR+Northam+Platinum+OR+Valterra+Platinum&hl=en-AU&gl=AU&ceid=AU:en', topic: 'producers' },
  { url: 'https://news.google.com/rss/search?q=palladium+rhodium+PGM+market&hl=en-AU&gl=AU&ceid=AU:en', topic: 'palladium' },
];

function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const rawTitle = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const sourceTag = extractTag(block, 'source');
    if (rawTitle && link) {
      let title = decodeEntities(stripCdata(rawTitle));
      if (sourceTag && title.endsWith(' - ' + decodeEntities(stripCdata(sourceTag)))) {
        title = title.slice(0, -(sourceTag.length + 3));
      }
      items.push({
        title,
        url: stripCdata(link).trim(),
        published_at: pubDate ? new Date(pubDate).toISOString() : null,
        publisher: sourceTag ? decodeEntities(stripCdata(sourceTag)) : null,
      });
    }
  }
  return items;
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

function stripCdata(str) {
  return str.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/1.0)' },
  });
  if (!res.ok) throw new Error(`${feed.topic} fetch failed: ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, 20).map((item) => ({
    ...item,
    source: item.publisher || 'Google News',
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

function mapStoryForClient(s) {
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
  };
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    await refreshNewsFromFeeds();
  } catch (err) {
    console.error('refreshNewsFromFeeds:', err.message);
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/news_stories?select=title,url,source,topic,published_at,fetched_at&order=published_at.desc.nullslast&limit=80`,
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

    const stories = top.map(mapStoryForClient);
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
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
