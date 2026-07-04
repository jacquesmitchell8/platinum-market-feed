/**
 * Shared Google News RSS fetch + parse utilities.
 */

const UA = 'Mozilla/5.0 (compatible; PlatinumMetisBot/2.0; +https://platinum-conflux.netlify.app)';

export function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

export function stripCdata(str) {
  return String(str || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

export function decodeEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function stripHtml(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

export function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const rawTitle = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const sourceTag = extractTag(block, 'source');
    const rawDesc = extractTag(block, 'description');
    if (!rawTitle || !link) continue;

    let title = decodeEntities(stripCdata(rawTitle));
    const publisher = sourceTag ? decodeEntities(stripCdata(sourceTag)) : null;
    if (publisher && title.endsWith(' - ' + publisher)) {
      title = title.slice(0, -(publisher.length + 3));
    }

    const description = rawDesc ? stripHtml(stripCdata(rawDesc)) : '';
    const published_at = pubDate ? new Date(pubDate).toISOString() : null;

    items.push({
      title,
      url: stripCdata(link).trim(),
      published_at,
      publisher,
      source: publisher || 'Google News',
      description,
    });
  }
  return items;
}

export function googleNewsRssUrl(query, { hl = 'en-AU', gl = 'AU', ceid = 'AU:en' } = {}) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

export async function fetchGoogleNewsRss(query, opts = {}) {
  const url = googleNewsRssUrl(query, opts);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`RSS fetch failed (${res.status}): ${query.slice(0, 60)}`);
  const xml = await res.text();
  return parseRssItems(xml).slice(0, opts.limit ?? 15);
}

export async function fetchGoogleNewsParallel(queries, opts = {}) {
  const limit = opts.limit ?? 12;
  const results = await Promise.allSettled(
    queries.map((q) => fetchGoogleNewsRss(q, { ...opts, limit }))
  );
  const merged = [];
  for (const r of results) {
    if (r.status === 'fulfilled') merged.push(...r.value);
  }
  return merged;
}
