// netlify/functions/fetch-news.js
//
// Scheduled ingest — fetches PGM Google News RSS into Supabase (deduped).
// news-digest.js reads only; does not refresh on every page load.

import { dedupeStories, normTitleForExport } from './lib/news-enrich.mjs';
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
    source: item.publisher || 'Google News',
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
    throw new Error(`Supabase batch upsert HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
  return payload.length;
}

export default async () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    return new Response('Missing env vars', { status: 500 });
  }

  const results = await Promise.allSettled(FEEDS.map((feed) => fetchFeed(feed)));
  const allItems = [];
  for (let i = 0; i < FEEDS.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') allItems.push(...r.value);
    else console.error(`Feed ${FEEDS[i].topic}:`, r.reason?.message);
  }

  try {
    const unique = dedupeStories(allItems);
    const inserted = await upsertStoriesBatch(unique);
    const summary = { ok: true, feeds: FEEDS.length, fetched: allItems.length, unique: unique.length, upserted: inserted };
    console.log('News fetch run complete:', JSON.stringify(summary));
    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('fetch-news:', err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 200 });
  }
};
