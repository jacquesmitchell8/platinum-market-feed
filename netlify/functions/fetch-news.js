// netlify/functions/fetch-news.js
//
// Scheduled function — runs twice daily at 7am and 7pm (see netlify.toml).
// Acts as a backup cadence in case the page isn't visited for a while —
// the primary refresh now happens live on every page load via news-digest.js.
// Uses the same Google News RSS source (reliable, not bot-blocked, no key).
//
// Required Netlify env vars:
//   SUPABASE_URL              -> <your Supabase project URL>
//   SUPABASE_SERVICE_ROLE_KEY -> secret key (NEVER the anon/publishable key, NEVER exposed to browser)

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
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PlatinumMetisBot/1.0)' }
  });
  if (!res.ok) throw new Error(`${feed.source}/${feed.topic} fetch failed: ${res.status}`);
  const xml = await res.text();
  const items = parseRssItems(xml);
  return items.slice(0, 20).map(item => ({
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
      Prefer: 'resolution=ignore-duplicates'
    },
    body: JSON.stringify({
      title: story.title,
      url: story.url,
      source: story.source,
      topic: story.topic,
      published_at: story.published_at,
      fetched_at: new Date().toISOString(),
    })
  });
  return res.ok;
}

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    return new Response('Missing env vars', { status: 500 });
  }

  const results = [];
  for (const feed of FEEDS) {
    try {
      const items = await fetchFeed(feed);
      let inserted = 0;
      for (const item of items) {
        if (await upsertStory(item)) inserted++;
      }
      results.push({ feed: feed.topic, ok: true, found: items.length, inserted });
    } catch (err) {
      console.error(err.message);
      results.push({ feed: feed.topic, ok: false, error: err.message });
    }
  }

  console.log('News fetch run complete:', JSON.stringify(results));

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
