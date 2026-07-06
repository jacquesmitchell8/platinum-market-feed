/**
 * Lightweight headline analysis — no LLM, keyword + topic scoring.
 */

const BULLISH = [
  'surge', 'rally', 'rise', 'gain', 'jump', 'soar', 'record high', 'tight supply', 'deficit',
  'shortage', 'strike ends', 'production up', 'output rise', 'demand growth', 'hydrogen',
  'pem fuel', 'jewellery demand', 'auto recovery', 'bullish', 'upgrade', 'outperform',
];
const BEARISH = [
  'fall', 'drop', 'decline', 'slump', 'crash', 'weak demand', 'surplus', 'oversupply',
  'layoff', 'shutdown', 'strike', 'power cut', 'load shedding', 'cost pressure', 'downgrade',
  'bearish', 'cut production', 'loss', 'impairment', 'retrench',
];

const THEMES = [
  { id: 'supply', label: 'Supply / mine output', words: ['mine', 'production', 'output', 'shaft', 'smelter', 'refinery', 'bushveld', 'strike', 'shutdown'] },
  { id: 'demand', label: 'Auto / industrial demand', words: ['automotive', 'catalyst', 'vehicle', 'industrial', 'jewellery', 'jewelry', 'demand'] },
  { id: 'deficit', label: 'Market balance', words: ['deficit', 'surplus', 'wpic', 'inventory', 'stockpile', 'above-ground'] },
  { id: 'pgm', label: 'PGM basket', words: ['platinum', 'palladium', 'rhodium', 'pgm', 'iridium', 'ruthenium'] },
  { id: 'sa', label: 'South Africa / JSE', words: ['south africa', 'jse', 'rand', 'eskom', 'load shedding', 'implats', 'impala', 'sibanye', 'northam', 'valterra'] },
  { id: 'macro', label: 'Macro / USD', words: ['dollar', 'fed', 'inflation', 'interest rate', 'china', 'recession', 'gold price'] },
];

function normTitle(title) {
  return String(title || '')
    .replace(/\s+by\s+[a-z0-9][\w\s.&'-]*$/i, '')
    .replace(/\s+-\s+[^-]+$/, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normTitleForExport(title) {
  return normTitle(title).slice(0, 120);
}

const TITLE_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'in', 'on', 'for', 'of', 'to', 'says', 'after']);

export function titleSimilarity(a, b) {
  const wa = new Set(normTitle(a).split(' ').filter((w) => w.length > 2 && !TITLE_STOP.has(w)));
  const wb = new Set(normTitle(b).split(' ').filter((w) => w.length > 2 && !TITLE_STOP.has(w)));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

export function storyDedupeKey(story) {
  const t = normTitle(story.title || story.headline);
  return t.slice(0, 72) || (story.url || '').split('?')[0].toLowerCase();
}

/** Drop exact-key and near-duplicate headlines (same logic as news-research). */
export function dedupeStories(rows) {
  const out = [];
  for (const row of rows) {
    const title = row.title || row.headline || '';
    const dup = out.some((o) => {
      if (storyDedupeKey(o) === storyDedupeKey(row)) return true;
      return titleSimilarity(o.title || o.headline, title) > 0.72;
    });
    if (!dup) out.push(row);
  }
  return out;
}

export function analyzeStory(story) {
  const title = story.title || '';
  const text = `${title} ${story.topic || ''}`.toLowerCase();
  let score = 0;
  for (const w of BULLISH) if (text.includes(w)) score += 1;
  for (const w of BEARISH) if (text.includes(w)) score -= 1;

  if (story.topic === 'platinum' || story.topic === 'producers') score += 0.5;
  if (story.topic === 'gold') score *= 0.6;

  const platinumImpact = score > 1 ? 2 : score === 1 ? 1 : score === 0 ? 0 : score === -1 ? -1 : -2;
  const direction = platinumImpact > 0 ? 'bullish' : platinumImpact < 0 ? 'bearish' : 'neutral';

  const themeLabels = THEMES
    .filter((th) => th.words.some((w) => text.includes(w)))
    .map((th) => th.label)
    .slice(0, 3);

  const bullets = [];
  if (platinumImpact > 0) bullets.push(`Net read for PGM complex: supportive (${direction}).`);
  else if (platinumImpact < 0) bullets.push(`Net read for PGM complex: headwind (${direction}).`);
  else bullets.push('Mixed or indirect read for platinum — watch PGM basket and auto demand.');

  if (themeLabels.length) bullets.push(`Themes: ${themeLabels.join(' · ')}.`);
  else bullets.push(`Topic: ${story.topic || 'markets'}.`);

  const relevanceScore = Math.min(100, Math.round(
    40 +
    (story.topic === 'platinum' ? 25 : story.topic === 'producers' ? 30 : story.topic === 'palladium' ? 15 : 5) +
    Math.abs(score) * 8
  ));

  return {
    headline: title,
    bullets,
    platinumImpact,
    direction,
    themeLabels,
    relevanceScore,
  };
}

export function pickTopStories(rows, limit = 3) {
  const unique = dedupeStories(rows);
  const scored = unique.map((row) => ({ ...row, ...analyzeStory(row) }));
  scored.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
    const ta = new Date(a.published_at || 0).getTime();
    const tb = new Date(b.published_at || 0).getTime();
    return tb - ta;
  });

  const top = [];
  const usedPublishers = new Set();
  const usedThemes = new Set();

  function tooSimilarToTop(candidate) {
    return top.some((t) => {
      if (storyDedupeKey(t) === storyDedupeKey(candidate)) return true;
      return titleSimilarity(t.title, candidate.title) > 0.55;
    });
  }

  for (const s of scored) {
    if (top.length >= limit) break;
    if (tooSimilarToTop(s)) continue;
    const pub = (s.source || '').toLowerCase();
    const themeKey = (s.themeLabels || [])[0] || s.topic || 'general';
    if (top.length < limit - 1 && usedPublishers.has(pub) && scored.length > limit + 2) continue;
    if (top.length < limit - 1 && usedThemes.has(themeKey) && scored.length > limit + 3) continue;
    usedPublishers.add(pub);
    usedThemes.add(themeKey);
    top.push({ ...s, rank: top.length + 1 });
  }
  for (const s of scored) {
    if (top.length >= limit) break;
    if (tooSimilarToTop(s)) continue;
    top.push({ ...s, rank: top.length + 1 });
  }
  return { top, rest: dedupeStories(scored.filter((s) => !top.some((t) => storyDedupeKey(t) === storyDedupeKey(s)))) };
}

export function buildProgression(stories) {
  if (!stories?.length) return null;
  const bullishScore = stories.reduce((sum, s) => sum + (s.platinumImpact || 0), 0);
  const direction =
    bullishScore >= 2 ? 'bullish' : bullishScore <= -2 ? 'bearish' : bullishScore !== 0 ? 'mixed' : 'neutral';

  const themeCounts = {};
  for (const s of stories) {
    for (const lbl of s.themeLabels || []) {
      themeCounts[lbl] = (themeCounts[lbl] || 0) + 1;
    }
  }
  const themeTrends = Object.entries(themeCounts)
    .map(([label, count]) => ({
      id: label,
      label,
      trend: count >= 2 ? 'strengthening' : 'stable',
    }))
    .slice(0, 5);

  const summary =
    direction === 'bullish'
      ? "Today's headlines lean supportive for platinum — supply tightness, demand, or PGM basket strength dominating."
      : direction === 'bearish'
        ? "Today's headlines lean negative for PGM miners — demand weakness, disruptions, or macro pressure in focus."
        : direction === 'mixed'
          ? 'Headlines are split — PGM-sensitive themes point both ways; balance sheet and JSE moves may diverge from spot.'
          : 'No strong directional signal in today\'s top stories — PGM spot may trade on macro and USD.';

  return { direction, bullishScore, summary, themeTrends };
}
