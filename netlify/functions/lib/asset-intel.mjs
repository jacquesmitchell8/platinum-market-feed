/**
 * Asset-level web intelligence for buy deep-dives (Platinum, Conflux).
 * Multi-query Google News sweeps + directional scoring — no LLM.
 */

import { fetchGoogleNewsParallel } from './rss-utils.mjs';
import { analyzeStory, storyDedupeKey, titleSimilarity } from './news-enrich.mjs';

const ASSET_PROFILES = {
  platinum: {
    id: 'platinum',
    label: 'Platinum',
    curveId: 'IDX-002',
    unit: 'USD/oz',
    queries: [
      'platinum price OR deficit OR WPIC when:30d',
      'Impala OR Sibanye OR Amplats platinum when:30d',
      'platinum hydrogen OR auto catalyst OR ETF when:30d',
    ],
    entities: [
      { label: 'WPIC', re: /\bwpic\b/i },
      { label: 'Deficit / surplus', re: /\bdeficit\b|\bsurplus\b|\bshortage\b/i },
      { label: 'Impala / Implats', re: /\bimpala\b|\bimplats\b/i },
      { label: 'Sibanye', re: /\bsibanye\b/i },
      { label: 'Hydrogen / PEM', re: /\bhydrogen\b|\bfuel cell\b|\bpem\b/i },
      { label: 'Auto catalysts', re: /\bcatalyst\b|\bautomotive\b|\bvehicle\b/i },
      { label: 'South Africa / Eskom', re: /\bsouth africa\b|\beskom\b|\bload shedding\b/i },
      { label: 'China demand', re: /\bchina\b|\bchinese\b|\bguangzhou\b/i },
      { label: 'ETF / investment', re: /\betf\b|\binvestment\b|\bholdings\b/i },
    ],
    bullish: [
      'deficit', 'shortage', 'tight supply', 'strike', 'load shedding', 'hydrogen',
      'fuel cell', 'rally', 'surge', 'record', 'demand growth', 'investment demand',
    ],
    bearish: [
      'surplus', 'oversupply', 'weak demand', 'etf unwind', 'outflow', 'slump',
      'decline', 'auto slowdown', 'ev substitution', 'cut production',
    ],
  },
  cfx: {
    id: 'cfx',
    label: 'Conflux Network',
    curveId: 'IDX-005',
    unit: 'USD',
    queries: [
      'Conflux Network OR CFX crypto when:30d',
      'Conflux eSpace OR partnership OR listing when:30d',
      'CFX token unlock OR China blockchain when:30d',
    ],
    entities: [
      { label: 'Conflux / CFX', re: /\bconflux\b|\bcfx\b/i },
      { label: 'eSpace / TVM', re: /\bespace\b|\btvm\b/i },
      { label: 'China / regulatory', re: /\bchina\b|\bchinese\b|\bregulatory\b/i },
      { label: 'Partnership / listing', re: /\bpartnership\b|\blisting\b|\bintegration\b/i },
      { label: 'DeFi / ecosystem', re: /\bdefi\b|\becosystem\b|\bdapp\b/i },
      { label: 'Token unlock / supply', re: /\bunlock\b|\btokenomics\b|\bsupply\b/i },
      { label: 'Layer-1 / altcoin', re: /\blayer.?1\b|\baltcoin\b|\bl1\b/i },
    ],
    bullish: [
      'rally', 'surge', 'partnership', 'listing', 'adoption', 'upgrade', 'ecosystem',
      'integration', 'growth', 'bullish', 'break', 'volume surge',
    ],
    bearish: [
      'hack', 'exploit', 'unlock', 'dump', 'delist', 'ban', 'regulatory crackdown',
      'slump', 'crash', 'selloff', 'outflow', 'bearish',
    ],
  },
};

function scoreHeadline(text, profile) {
  const t = text.toLowerCase();
  let score = 0;
  for (const w of profile.bullish) if (t.includes(w)) score += 1;
  for (const w of profile.bearish) if (t.includes(w)) score -= 1;
  return score;
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = storyDedupeKey(item);
    if (!key || seen.has(key)) continue;
    if (out.some((e) => titleSimilarity(e.title, item.title) > 0.72)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractAssetMentions(items, profile) {
  const map = new Map();
  for (const item of items) {
    const blob = `${item.title} ${item.description || ''}`;
    for (const ent of profile.entities) {
      if (!ent.re.test(blob)) continue;
      const ex = map.get(ent.label) || { label: ent.label, count: 0, contexts: [] };
      ex.count += 1;
      if (ex.contexts.length < 3) ex.contexts.push(item.title.slice(0, 90));
      map.set(ent.label, ex);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 10);
}

/**
 * Deep web research for one buy-candidate asset.
 */
export async function researchAssetIntel(assetKey, opts = {}) {
  const profile = ASSET_PROFILES[assetKey];
  if (!profile) throw new Error(`Unknown asset: ${assetKey}`);

  const started = Date.now();
  let raw = [];
  try {
    raw = await fetchGoogleNewsParallel(profile.queries, {
      limit: opts.perQuery ?? 10,
      signal: opts.signal,
    });
  } catch (err) {
    console.error(`researchAssetIntel ${assetKey}:`, err.message);
  }

  const unique = dedupeItems(raw).slice(0, opts.maxArticles ?? 20);
  unique.sort((a, b) => new Date(a.published_at || 0) - new Date(b.published_at || 0));

  let netScore = 0;
  const headlines = unique.map((item) => {
    const s = scoreHeadline(`${item.title} ${item.description || ''}`, profile);
    netScore += s;
    const enriched = analyzeStory({
      title: item.title,
      topic: assetKey === 'platinum' ? 'platinum' : 'crypto',
    });
    return {
      headline: item.title,
      url: item.url,
      source: item.source || item.publisher || 'Web',
      publishedAt: item.published_at,
      snippet: (item.description || '').slice(0, 200),
      direction: s > 0 ? 'bullish' : s < 0 ? 'bearish' : 'neutral',
      impact: s,
      themes: enriched.themeLabels || [],
    };
  });

  const mentions = extractAssetMentions(unique, profile);
  const bullishN = headlines.filter((h) => h.direction === 'bullish').length;
  const bearishN = headlines.filter((h) => h.direction === 'bearish').length;

  let newsBias = 'neutral';
  if (netScore >= 3 || bullishN >= bearishN + 3) newsBias = 'bullish';
  else if (netScore <= -3 || bearishN >= bullishN + 3) newsBias = 'bearish';
  else if (netScore !== 0) newsBias = 'mixed';

  const recent = headlines.slice(-8);
  const narrative = buildAssetNarrative(profile, headlines, mentions, newsBias, netScore);

  return {
    asset: profile.id,
    label: profile.label,
    curveId: profile.curveId,
    unit: profile.unit,
    newsBias,
    netScore,
    articleCount: headlines.length,
    bullishCount: bullishN,
    bearishCount: bearishN,
    mentions,
    headlines: headlines.slice().reverse().slice(0, 12),
    recentHeadlines: recent.slice().reverse(),
    narrative,
    researchedAt: new Date().toISOString(),
    researchMs: Date.now() - started,
  };
}

function buildAssetNarrative(profile, headlines, mentions, newsBias, netScore) {
  if (!headlines.length) {
    return `Thin web coverage for ${profile.label} in the last month — lean harder on price structure and known fundamentals.`;
  }
  const topMentions = mentions.slice(0, 4).map((m) => m.label).join(', ');
  let n = `Scanned ${headlines.length} unique ${profile.label} articles across the open web. `;
  if (newsBias === 'bullish') {
    n += `Coverage leans supportive (score ${netScore > 0 ? '+' : ''}${netScore}) — supply, demand, or ecosystem catalysts dominate. `;
  } else if (newsBias === 'bearish') {
    n += `Coverage leans cautious (score ${netScore}) — demand, supply, or risk headlines outweigh positives. `;
  } else if (newsBias === 'mixed') {
    n += `Coverage is split (score ${netScore > 0 ? '+' : ''}${netScore}) — confirm with curve structure before sizing. `;
  } else {
    n += `No strong directional skew in headlines. `;
  }
  if (topMentions) n += `Major mentions: ${topMentions}. `;
  const latest = headlines[headlines.length - 1];
  if (latest) n += `Latest: "${latest.headline.slice(0, 100)}${latest.headline.length > 100 ? '…' : ''}" (${latest.source}).`;
  return n;
}

export async function researchBuyAssets(assetKeys = ['platinum', 'cfx']) {
  // Sequential — fewer concurrent outbound RSS calls (avoids provider / host quotas).
  const assets = {};
  for (const key of assetKeys) {
    try {
      assets[key] = await researchAssetIntel(key, { perQuery: 8, maxArticles: 14 });
    } catch (err) {
      assets[key] = { asset: key, error: err.message || 'Research failed', articleCount: 0 };
    }
  }
  return assets;
}

export { ASSET_PROFILES };
