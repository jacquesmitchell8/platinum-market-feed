// netlify/functions/deploy-succeeded.js
//
// On deploy: ingest latest prices into Supabase, then propagate curve history.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default {
  async deploySucceeded(event) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Missing Supabase env vars — skipping post-deploy propagate');
      return;
    }

    const siteUrl = event?.site?.url || event?.deploy?.url;
    if (!siteUrl) {
      console.error('No site URL in deploy event — cannot self-call functions');
      return;
    }

    console.log('Deploy succeeded — propagating curves into Supabase');

    const targets = [
      '/.netlify/functions/propagate-curves',
      '/.netlify/functions/fetch-market-snapshots',
      '/.netlify/functions/news-digest',
      '/.netlify/functions/producer-stocks',
      '/.netlify/functions/perth-mint',
    ];
    for (const path of targets) {
      try {
        const res = await fetch(`${siteUrl}${path}`);
        console.log(`Post-deploy ${path}: ${res.status}`);
      } catch (err) {
        console.error(`Post-deploy ${path} failed: ${err.message}`);
      }
    }
  }
};
