// netlify/functions/fetch-news.js
//
// Scheduled ingest — direct Asian / SA / metals-desk RSS into Supabase (deduped).
// No Google News wrappers.

import { dedupeStories, normTitleForExport } from './lib/news-enrich.mjs';
import { parseRssItems } from './lib/rss-utils.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FEEDS = [
  { url: 'https://www.businesstimes.com.sg/rss/feed/bt_commodities', source: 'Business Times Singapore', topic: 'platinum' },
  { url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=10416', source: 'Channel News Asia', topic: 'macro' },
  { url: 'https://www.scmp.com/rss/91/feed', source: 'South China Morning Post', topic: 'macro' },
  { url: 'https://www.xinhuanet.com/english/rss/worldrss.xml', source: 'Xinhua English', topic: 'macro' },
  { url: 'https://asia.nikkei.com/rss/feed/nar', source: 'Nikkei Asia', topic: 'macro' },
  { url: 'https://www.moneyweb.co.za/feed/', source: 'Moneyweb', topic: 'producers' },
  { url: 'https://www.mining.com/feed/', source: 'Mining.com', topic: 'platinum' },
  { url: 'https://www.kitco.com/news/rss/news.xml', source: 'Kitco Metals', topic: 'platinum' },
  { url: 'https://www.investing.com/rss/news_285.rss', source: 'Investing.com · Platinum', topic: 'platinum' },
];

const PGM_RE = /\b(platinum|palladium|rhodium|pgm|pgms|implats|impala|sibanye|northam|wpic|lbma|hydrogen|catalyst|fuel.?cell|precious.?metal|norilsk|nornickel|mining)\b/i;

function isRelevant(item, topic) {
  const text = `${item.title} ${item.description || ''}`.toLowerCase();
  if (PGM_RE.test(text)) return true;
  if (topic === 'producers' && /\b(jse|eskom|bushveld|rand)\b/i.test(text)) return true;
  return topic === 'platinum';
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/2.0)' },
  });
  if (!res.ok) throw new Error(`${feed.source} fetch failed: ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, 28)
    .filter((item) => isRelevant(item, feed.topic))
    .map((item) => ({
      ...item,
      source: item.publisher || feed.source,
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
    else console.error(`Feed ${FEEDS[i].source}:`, r.reason?.message);
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
