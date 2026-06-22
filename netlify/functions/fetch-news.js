// netlify/functions/fetch-news.js
//
// Scheduled function — runs twice daily at 7am and 7pm (see netlify.toml).
// Pulls RSS feeds from Mining.com (gold/platinum/palladium tags) and Kitco
// (mining category), parses items, and upserts into Supabase `news_stories`.
//
// Required Netlify env vars:
//   SUPABASE_URL              -> https://tjxiaidxcwpvsnwfvdck.supabase.co (market-feed project)
//   SUPABASE_SERVICE_ROLE_KEY -> secret key (NEVER the anon/publishable key, NEVER exposed to browser)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FEEDS = [
  { url: 'https://www.mining.com/tag/gold/feed/', source: 'mining.com', topic: 'gold' },
  { url: 'https://www.mining.com/tag/platinum/feed/', source: 'mining.com', topic: 'platinum' },
  { url: 'https://www.mining.com/tag/palladium/feed/', source: 'mining.com', topic: 'palladium' },
  { url: 'https://www.kitco.com/news/category/mining/rss', source: 'kitco.com', topic: 'mining' },
];

// Minimal RSS/Atom <item> parser — no external deps, just regex over the XML.
// RSS items look like: <item><title>..</title><link>..</link><pubDate>..</pubDate></item>
function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    if (title && link) {
      items.push({
        title: decodeEntities(stripCdata(title)),
        url: stripCdata(link).trim(),
        published_at: pubDate ? new Date(pubDate).toISOString() : null,
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
  // Cap to most recent 15 per feed to avoid flooding the table on first run
  return items.slice(0, 15).map(item => ({
    ...item,
    source: feed.source,
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert failed for "${story.title}": ${res.status} ${text}`);
  }
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
        try {
          await upsertStory(item);
          inserted++;
        } catch (err) {
          // Likely a duplicate URL (unique constraint) — expected on repeat runs, not fatal
          console.log(`Skip (likely duplicate): ${item.title} - ${err.message}`);
        }
      }
      results.push({ feed: `${feed.source}/${feed.topic}`, ok: true, found: items.length, inserted });
    } catch (err) {
      console.error(err.message);
      results.push({ feed: `${feed.source}/${feed.topic}`, ok: false, error: err.message });
    }
  }

  console.log('News fetch run complete:', JSON.stringify(results));

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
