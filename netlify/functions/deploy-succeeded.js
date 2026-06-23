// netlify/functions/deploy-succeeded.js
//
// Event-triggered function (Netlify auto-runs this on every successful
// deploy). Refreshes all data feeds and propagates curve history into
// Supabase so charts work immediately after deploy without waiting for
// a visitor or the scheduled cron jobs.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default {
  async deploySucceeded(event) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars — skipping post-deploy refresh');
      return;
    }

    console.log('Deploy succeeded — propagating curve history and refreshing feeds');

    const siteUrl = event?.site?.url || event?.deploy?.url;
    if (!siteUrl) {
      console.error('No site URL available in deploy-succeeded event payload — cannot self-call refresh functions');
      return;
    }

    const targets = [
      '/.netlify/functions/fetch-market-snapshots',
      '/.netlify/functions/metals-history?symbol=XAU',
      '/.netlify/functions/metals-history?symbol=XPT',
      '/.netlify/functions/crypto-history?id=bitcoin',
      '/.netlify/functions/crypto-history?id=ethereum',
      '/.netlify/functions/crypto-history?id=conflux-token',
      '/.netlify/functions/news-digest',
      '/.netlify/functions/producer-stocks',
      '/.netlify/functions/perth-mint',
    ];
    for (const path of targets) {
      try {
        const res = await fetch(`${siteUrl}${path}`);
        console.log(`Post-deploy propagate ${path}: ${res.status}`);
      } catch (err) {
        console.error(`Post-deploy propagate ${path} failed: ${err.message}`);
      }
    }
  }
};
