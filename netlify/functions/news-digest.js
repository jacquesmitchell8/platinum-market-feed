// netlify/functions/news-digest.js
//
// Called by the dashboard's NewsPanel on every page load.
// On each call: fetches fresh RSS from Mining.com + Kitco, upserts into
// Supabase `news_stories` (so there's a running historical record), then
// returns today's top stories in the shape the dashboard expects.
//
// This means the page always shows the freshest possible headlines, while
// Supabase keeps accumulating history for later reference. The separate
// fetch-news.js scheduled function (7am/7pm) still runs as a backup cadence
// in case the page isn't visited for a while.
//
// Required Netlify env vars:
//   SUPABASE_URL              -> <your Supabase project URL>
//   SUPABASE_SERVICE_ROLE_KEY -> secret key (needed here because this function writes, not just reads)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Google News RSS is served by Google's own infrastructure (not a small
// publisher's Cloudflare-protected server), so it doesn't get bot-blocked
// the way direct scrapes of Mining.com/GoldSeek/Kitco did. No API key needed.
const FEEDS = [
  { url: 'https://news.google.com/rss/search?q=platinum+mining&hl=en-US&gl=US&ceid=US:en', source: 'google-news', topic: 'platinum' },
  { url: 'https://news.google.com/rss/search?q=gold+price&hl=en-US&gl=US&ceid=US:en', source: 'google-news', topic: 'gold' },
  { url: 'https://news.google.com/rss/search?q=palladium+market&hl=en-US&gl=US&ceid=US:en', source: 'google-news', topic: 'palladium' },
];

function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const rawTitle = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const sourceTag = extractTag(block, 'source'); // Google News includes <source url="...">Publisher Name</source>
    if (rawTitle && link) {
      let title = decodeEntities(stripCdata(rawTitle));
      // Google News titles are formatted "Headline - Publisher" — strip the trailing publisher name
      // since we already capture it separately via the <source> tag.
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
  return items.slice(0, 15).map(item => ({
    ...item,
    source: item.publisher || feed.source,
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

async function refreshNewsFromFeeds() {
  for (const feed of FEEDS) {
    try {
      const items = await fetchFeed(feed);
      console.log(`Feed ${feed.source}/${feed.topic}: found ${items.length} items`);
      let inserted = 0;
      for (const item of items) {
        const ok = await upsertStory(item);
        if (ok) inserted++;
      }
      console.log(`Feed ${feed.source}/${feed.topic}: inserted ${inserted} new (rest were duplicates)`);
    } catch (err) {
      console.error(`Feed refresh failed for ${feed.source}/${feed.topic}: ${err.message}`);
    }
  }
}

function digestDateUTC() {
  return new Date().toISOString().slice(0, 10);
}

export default async (req) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing Supabase env vars' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    await refreshNewsFromFeeds();
  } catch (err) {
    console.error('refreshNewsFromFeeds failed entirely: ' + err.message);
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/news_stories?select=title,url,source,topic,published_at,fetched_at&order=fetched_at.desc&limit=30`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
    });
    if (!res.ok) throw new Error(`Supabase read failed: ${res.status}`);
    const rows = await res.json();

    if (!rows.length) {
      return new Response(JSON.stringify({ ok: false, error: 'No news stories available yet' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const topStories = rows.slice(0, 3).map((r, i) => ({
      title: r.title, url: r.url, source: r.source, publishedAt: r.published_at, rank: i + 1,
    }));
    const pastStories = rows.slice(3).map((r) => ({
      title: r.title, url: r.url, source: r.source, publishedAt: r.published_at,
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
