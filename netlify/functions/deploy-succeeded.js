// netlify/functions/deploy-succeeded.js
//
// Event-triggered function (Netlify auto-runs this on every successful
// deploy, purely by filename convention — no schedule or wiring needed).
// Fires the same news + producer refresh that runs on page load, so the
// data is fresh immediately after any code change goes live, without
// waiting for a visitor or the 7am/7pm scheduled backup.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default {
  async deploySucceeded(event) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars — skipping post-deploy refresh');
      return;
    }

    console.log('Deploy succeeded — triggering news and producer refresh');

    const siteUrl = event?.site?.url || event?.deploy?.url;
    if (!siteUrl) {
      console.error('No site URL available in deploy-succeeded event payload — cannot self-call refresh functions');
      return;
    }

    const targets = ['/.netlify/functions/news-digest', '/.netlify/functions/producer-stocks'];
    for (const path of targets) {
      try {
        const res = await fetch(`${siteUrl}${path}`);
        console.log(`Post-deploy refresh ${path}: ${res.status}`);
      } catch (err) {
        console.error(`Post-deploy refresh ${path} failed: ${err.message}`);
      }
    }
  }
};
