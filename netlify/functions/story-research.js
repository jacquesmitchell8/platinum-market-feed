// netlify/functions/story-research.js
//
// On-demand deep dive for a single PGM headline — multi-query Google News sweep,
// chronological timeline, major mentions, progression narrative.

import { researchStory } from './lib/news-research.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const headline = url.searchParams.get('headline') || url.searchParams.get('title') || '';
  const storyUrl = url.searchParams.get('url') || '';
  const topic = url.searchParams.get('topic') || 'platinum';
  const source = url.searchParams.get('source') || '';
  const publishedAt = url.searchParams.get('publishedAt') || null;

  if (!headline && !storyUrl) {
    return new Response(JSON.stringify({ ok: false, error: 'headline or url required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  try {
    const research = await researchStory({
      headline,
      title: headline,
      url: storyUrl,
      topic,
      source,
      publishedAt,
    });

    return new Response(JSON.stringify({ ok: true, research }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=7200',
        ...CORS,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }
};
