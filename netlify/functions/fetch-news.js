// netlify/functions/fetch-news.js
//
// Scheduled ingest — trade RSS + Google News web sweeps → Supabase.
// Browser reads Supabase only (no client RSS, no per-load function calls).
// No Yahoo. Web coverage comes from Google News RSS search queries.

import { dedupeStories, normTitleForExport } from './lib/news-enrich.mjs';
import { parseRssItems, fetchGoogleNewsParallel } from './lib/rss-utils.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// region: price = LBMA/paper/trade press | supply = SA/JSE miners | demand = Asia industrial
const FEEDS = [
  { url: 'https://www.kitco.com/news/rss/news.xml', source: 'Kitco Metals', topic: 'platinum', region: 'price' },
  { url: 'https://www.mining.com/feed/', source: 'Mining.com', topic: 'platinum', region: 'price' },
  { url: 'https://www.investing.com/rss/news_285.rss', source: 'Investing.com · Platinum', topic: 'platinum', region: 'price' },
  { url: 'https://www.platinumguild.com/rss/news', source: 'Platinum Guild International', topic: 'platinum', region: 'price' },
  { url: 'https://www.moneyweb.co.za/feed/', source: 'Moneyweb', topic: 'producers', region: 'supply' },
  { url: 'https://www.businesstimes.com.sg/rss/feed/bt_commodities', source: 'Business Times Singapore', topic: 'platinum', region: 'demand' },
  { url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=10416', source: 'Channel News Asia', topic: 'macro', region: 'demand' },
  { url: 'https://www.scmp.com/rss/91/feed', source: 'South China Morning Post', topic: 'macro', region: 'demand' },
  { url: 'https://www.xinhuanet.com/english/rss/worldrss.xml', source: 'Xinhua English', topic: 'macro', region: 'demand' },
  { url: 'https://www.globaltimes.cn/rss/outbrain.xml', source: 'Global Times', topic: 'macro', region: 'demand' },
  { url: 'https://asia.nikkei.com/rss/feed/nar', source: 'Nikkei Asia', topic: 'macro', region: 'demand' },
];

// Open-web sweeps via Google News RSS (not Yahoo).
const WEB_SWEEPS = [
  {
    region: 'price',
    topic: 'platinum',
    queries: [
      'platinum price OR spot OR LBMA when:3d',
      'platinum deficit OR surplus OR WPIC when:7d',
      'palladium OR rhodium PGM price when:3d',
      'platinum gold ratio OR precious metals when:3d',
      'platinum ETF holdings OR GLTR OR PPLT when:7d',
      'Kitco OR Mining.com platinum when:3d',
    ],
  },
  {
    region: 'supply',
    topic: 'producers',
    queries: [
      'Impala OR Implats OR Sibanye OR Northam OR Valterra platinum when:7d',
      'South Africa platinum mining OR Bushveld OR Eskom when:7d',
      'Anglo American Platinum OR Amplats OR Norilsk PGM when:7d',
      'JSE platinum OR PGM production strike OR smelter when:7d',
      'platinum mine output OR refined production OR recycling when:7d',
    ],
  },
  {
    region: 'demand',
    topic: 'macro',
    queries: [
      'platinum hydrogen OR fuel cell OR auto catalyst when:7d',
      'China platinum OR palladium demand OR jewellery when:7d',
      'platinum ETF OR investment demand when:7d',
      'platinum automotive catalyst OR EV substitution when:7d',
      'Japan OR India platinum jewellery OR industrial demand when:7d',
    ],
  },
];

const PGM_RE = /\b(platinum|palladium|rhodium|pgm|pgms|implats|impala|sibanye|northam|valterra|amplats|wpic|lbma|hydrogen|catalyst|fuel.?cell|precious.?metal|norilsk|nornickel|conflux|cfx)\b/i;

function isRelevant(item, feed) {
  const text = `${item.title} ${item.description || ''}`.toLowerCase();
  if (PGM_RE.test(text)) return true;
  if (feed.region === 'supply' && /\b(jse|eskom|bushveld|rand|mining)\b/i.test(text)) return true;
  if (feed.region === 'demand' && /\b(commodit|metal|import|auto|ev)\b/i.test(text)) return true;
  return feed.region === 'price';
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/2.0)' },
  });
  if (!res.ok) throw new Error(`${feed.source} fetch failed: ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, 28)
    .filter((item) => isRelevant(item, feed))
    .map((item) => ({
      ...item,
      source: item.publisher || feed.source,
      topic: feed.topic,
      region: feed.region,
    }));
}

async function fetchWebSweep(sweep) {
  const items = await fetchGoogleNewsParallel(sweep.queries, { limit: 12 });
  return items
    .filter((item) => PGM_RE.test(`${item.title} ${item.description || ''}`))
    .map((item) => ({
      ...item,
      source: item.publisher || item.source || 'Google News',
      topic: sweep.topic,
      region: sweep.region,
    }));
}

async function upsertStoriesBatch(stories) {
  if (!stories.length) return 0;
  const payload = stories.map((story) => ({
    title: story.title,
    url: story.url,
    source: story.source,
    topic: story.topic,
    region: story.region,
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
      Prefer: 'resolution=merge-duplicates',
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
    console.error('Missing SUPABASE env vars');
    return new Response('Missing env vars', { status: 500 });
  }

  const feedResults = await Promise.allSettled(FEEDS.map((feed) => fetchFeed(feed)));
  const webResults = await Promise.allSettled(WEB_SWEEPS.map((sweep) => fetchWebSweep(sweep)));

  const allItems = [];
  for (let i = 0; i < FEEDS.length; i++) {
    const r = feedResults[i];
    if (r.status === 'fulfilled') allItems.push(...r.value);
    else console.error(`Feed ${FEEDS[i].source}:`, r.reason?.message);
  }
  let webHits = 0;
  for (let i = 0; i < WEB_SWEEPS.length; i++) {
    const r = webResults[i];
    if (r.status === 'fulfilled') {
      allItems.push(...r.value);
      webHits += r.value.length;
    } else {
      console.error(`Web sweep ${WEB_SWEEPS[i].region}:`, r.reason?.message);
    }
  }

  try {
    const unique = dedupeStories(allItems);
    const inserted = await upsertStoriesBatch(unique);
    const byRegion = unique.reduce((acc, s) => {
      acc[s.region] = (acc[s.region] || 0) + 1;
      return acc;
    }, {});
    const summary = {
      ok: true,
      feeds: FEEDS.length,
      webSweeps: WEB_SWEEPS.length,
      webHits,
      unique: unique.length,
      upserted: inserted,
      byRegion,
    };
    console.log('News ingest:', JSON.stringify(summary));
    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('fetch-news:', err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 200 });
  }
};
