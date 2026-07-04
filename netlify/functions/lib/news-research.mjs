/**
 * Multi-source web research for PGM news — parallel Google News RSS sweeps,
 * chronological timeline, entity extraction, progression narrative.
 * No LLM: synthesis from real headlines + snippets across the open web.
 */

import { fetchGoogleNewsParallel, stripHtml } from './rss-utils.mjs';
import { analyzeStory, storyDedupeKey, titleSimilarity } from './news-enrich.mjs';

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'as', 'by',
  'with', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'will',
  'says', 'said', 'after', 'over', 'into', 'its', 'their', 'this', 'that', 'new', 'latest',
]);

const ENTITIES = [
  { type: 'producer', label: 'Impala Platinum', patterns: [/\bimpala platinum\b/i, /\bimplats\b/i] },
  { type: 'producer', label: 'Sibanye-Stillwater', patterns: [/\bsibanye\b/i, /\bstillwater\b/i] },
  { type: 'producer', label: 'Anglo American Platinum', patterns: [/\banglo american platinum\b/i, /\bamplats\b/i] },
  { type: 'producer', label: 'Northam Platinum', patterns: [/\bnortham platinum\b/i, /\bnortham\b/i] },
  { type: 'producer', label: 'Valterra Platinum', patterns: [/\bvalterra\b/i] },
  { type: 'producer', label: 'Ivanhoe Mines', patterns: [/\bivanhoe\b/i] },
  { type: 'institution', label: 'WPIC', patterns: [/\bwpic\b/i, /\bworld platinum investment council\b/i] },
  { type: 'institution', label: 'LBMA', patterns: [/\blbma\b/i] },
  { type: 'institution', label: 'JSE', patterns: [/\bjse\b/i, /\bjohannesburg stock exchange\b/i] },
  { type: 'institution', label: 'Eskom', patterns: [/\beskom\b/i] },
  { type: 'metal', label: 'Platinum', patterns: [/\bplatinum\b/i, /\bpt\b/i] },
  { type: 'metal', label: 'Palladium', patterns: [/\bpalladium\b/i, /\bpd\b/i] },
  { type: 'metal', label: 'Rhodium', patterns: [/\brhodium\b/i] },
  { type: 'theme', label: 'Hydrogen / fuel cells', patterns: [/\bhydrogen\b/i, /\bfuel cell\b/i, /\bpem\b/i] },
  { type: 'theme', label: 'Auto catalyst demand', patterns: [/\bcatalyst\b/i, /\bautomotive\b/i, /\bvehicle\b/i, /\bev\b/i, /\belectric vehicle\b/i] },
  { type: 'theme', label: 'South Africa supply', patterns: [/\bsouth africa\b/i, /\bbushveld\b/i, /\bload shedding\b/i] },
  { type: 'theme', label: 'Market deficit / surplus', patterns: [/\bdeficit\b/i, /\bsurplus\b/i, /\bshortage\b/i, /\bstockpile\b/i] },
  { type: 'macro', label: 'USD / Fed', patterns: [/\bdollar\b/i, /\bfed\b/i, /\binterest rate\b/i] },
  { type: 'macro', label: 'China demand', patterns: [/\bchina\b/i, /\bchinese\b/i] },
];

const METRIC_RE = [
  { type: 'volume', re: /(\d[\d,]*(?:\.\d+)?)\s*(?:koz|moz|oz)\b/gi, label: 'PGM volume' },
  { type: 'price', re: /\$\s*(\d[\d,]*(?:\.\d+)?)\s*(?:\/\s*oz)?/gi, label: 'USD price' },
  { type: 'pct', re: /([+-]?\d+(?:\.\d+)?)\s*%/g, label: 'percentage move' },
  { type: 'deficit', re: /deficit\s+of\s+(\d[\d,]*)\s*koz/gi, label: 'market deficit' },
];

function significantWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function extractPhrases(headline) {
  const words = significantWords(headline);
  const phrases = [];
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i <= words.length - n; i++) {
      phrases.push(words.slice(i, i + n).join(' '));
    }
  }
  return [...new Set(phrases)].slice(0, 6);
}

export function buildResearchQueries(story) {
  const headline = story.headline || story.title || '';
  const topic = story.topic || 'platinum';
  const phrases = extractPhrases(headline);
  const queries = new Set();

  if (phrases[0]) queries.add(phrases[0]);
  if (phrases[1]) queries.add(phrases[1]);

  const core = significantWords(headline).slice(0, 5).join(' ');
  if (core) {
    queries.add(`${core} platinum PGM`);
    queries.add(`${core} mining OR deficit OR WPIC`);
  }

  if (topic === 'producers') {
    queries.add(`${significantWords(headline).slice(0, 3).join(' ')} JSE OR South Africa mining`);
  } else if (topic === 'palladium') {
    queries.add(`${significantWords(headline).slice(0, 3).join(' ')} palladium rhodium PGM`);
  } else {
    queries.add(`${significantWords(headline).slice(0, 3).join(' ')} platinum market WPIC`);
  }

  queries.add('platinum deficit OR WPIC OR PGM supply when:7d');
  queries.add('Impala OR Sibanye OR Amplats platinum when:7d');

  return [...queries].filter(Boolean).slice(0, 7);
}

function relevanceToStory(item, story) {
  const headline = (story.headline || story.title || '').toLowerCase();
  const text = `${item.title} ${item.description || ''}`.toLowerCase();
  const sim = titleSimilarity(headline, item.title);
  const hw = significantWords(headline);
  const overlap = hw.filter((w) => text.includes(w)).length;
  const pgmHit = /\b(platinum|palladium|rhodium|pgm|implats|sibanye|wpic|mining)\b/i.test(text);

  let score = sim * 50 + overlap * 8;
  if (pgmHit) score += 15;
  if (item.url === story.url) score += 100;
  if (story.topic && text.includes(story.topic)) score += 5;
  return score;
}

function dedupeArticles(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = storyDedupeKey(item);
    if (!key || seen.has(key)) continue;
    let dup = false;
    for (const existing of out) {
      if (titleSimilarity(existing.title, item.title) > 0.72) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractMentions(text, sourceLabel) {
  const mentions = [];
  const blob = String(text || '');

  for (const ent of ENTITIES) {
    for (const pat of ent.patterns) {
      if (pat.test(blob)) {
        mentions.push({
          type: ent.type,
          label: ent.label,
          source: sourceLabel,
        });
        break;
      }
    }
  }

  for (const { type, re, label } of METRIC_RE) {
    const reCopy = new RegExp(re.source, re.flags);
    let m;
    while ((m = reCopy.exec(blob)) !== null && mentions.length < 24) {
      mentions.push({
        type: 'metric',
        label: `${label}: ${m[0].trim()}`,
        source: sourceLabel,
      });
    }
  }

  return mentions;
}

function classifyTimelineRole(item, index, total, isOrigin) {
  if (isOrigin) return 'origin';
  if (index === total - 1) return 'latest';
  const t = `${item.title} ${item.description || ''}`.toLowerCase();
  if (/\b(analysis|commentary|outlook|explainer|what to know|deep dive)\b/i.test(t)) return 'analysis';
  if (/\b(update|follow|after|responds|expands|widens|narrows)\b/i.test(t)) return 'followup';
  return 'coverage';
}

function buildProgressionNarrative(timeline, story) {
  if (!timeline.length) {
    return {
      phases: [],
      narrative: 'Limited cross-web coverage found for this headline — it may be very new or niche.',
      coverageDepth: 'thin',
    };
  }

  const phases = [];
  const origin = timeline.find((t) => t.role === 'origin') || timeline[0];
  phases.push({
    phase: 'Breaks',
    when: origin.publishedAt,
    summary: `Story surfaces via ${origin.source}: "${origin.headline.slice(0, 90)}${origin.headline.length > 90 ? '…' : ''}"`,
  });

  const followups = timeline.filter((t) => t.role === 'followup' || t.role === 'coverage');
  if (followups.length) {
    const latest = followups[followups.length - 1];
    phases.push({
      phase: 'Develops',
      when: latest.publishedAt,
      summary: `${followups.length} additional outlet${followups.length > 1 ? 's' : ''} picked up the thread — latest from ${latest.source}.`,
    });
  }

  const analysis = timeline.filter((t) => t.role === 'analysis');
  if (analysis.length) {
    phases.push({
      phase: 'Context',
      when: analysis[analysis.length - 1].publishedAt,
      summary: `Analytical takes appear (${analysis.map((a) => a.source).slice(0, 3).join(', ')}) — market implications being debated.`,
    });
  }

  const latest = timeline[timeline.length - 1];
  if (latest && latest.url !== origin.url) {
    phases.push({
      phase: 'Current read',
      when: latest.publishedAt,
      summary: `Most recent angle (${latest.source}): ${latest.headline.slice(0, 100)}${latest.headline.length > 100 ? '…' : ''}`,
    });
  }

  const sources = new Set(timeline.map((t) => t.source));
  const coverageDepth = timeline.length >= 6 ? 'deep' : timeline.length >= 3 ? 'moderate' : 'thin';
  const analysisResult = analyzeStory(story);

  let narrative = `Tracked ${timeline.length} related piece${timeline.length > 1 ? 's' : ''} across ${sources.size} source${sources.size > 1 ? 's' : ''}. `;
  if (coverageDepth === 'deep') {
    narrative += 'This is a developing thread with broad web pickup — not a one-off headline. ';
  } else if (coverageDepth === 'moderate') {
    narrative += 'Coverage is building but still concentrated — watch for follow-through. ';
  } else {
    narrative += 'Early-stage coverage — confirm with producer filings and spot before sizing risk. ';
  }
  narrative += analysisResult.bullets[0] || '';

  return { phases, narrative, coverageDepth, sourceCount: sources.size };
}

/**
 * Deep-dive a single story across multiple Google News queries.
 */
export async function researchStory(story, opts = {}) {
  const headline = story.headline || story.title || '';
  const queries = buildResearchQueries(story);
  const started = Date.now();

  let rawItems = [];
  try {
    rawItems = await fetchGoogleNewsParallel(queries, {
      limit: opts.perQuery ?? 10,
      signal: opts.signal,
    });
  } catch (err) {
    console.error('researchStory fetch:', err.message);
  }

  const seed = {
    title: headline,
    url: story.url,
    source: story.source,
    published_at: story.publishedAt || story.published_at,
    description: '',
  };
  rawItems.unshift(seed);

  const scored = rawItems
    .map((item) => ({ ...item, _relevance: relevanceToStory(item, story) }))
    .filter((item) => item._relevance >= 12)
    .sort((a, b) => b._relevance - a._relevance);

  const unique = dedupeArticles(scored).slice(0, opts.maxArticles ?? 14);

  unique.sort((a, b) => {
    const ta = new Date(a.published_at || 0).getTime();
    const tb = new Date(b.published_at || 0).getTime();
    return ta - tb;
  });

  const originUrl = (story.url || '').split('?')[0];
  const timeline = unique.map((item, i) => ({
    headline: item.title,
    url: item.url,
    source: item.source || item.publisher || 'Unknown',
    publishedAt: item.published_at,
    snippet: (item.description || '').slice(0, 220),
    role: classifyTimelineRole(
      item,
      i,
      unique.length,
      (item.url || '').split('?')[0] === originUrl
    ),
    relevance: Math.round(item._relevance || 0),
  }));

  const mentionMap = new Map();
  for (const item of unique) {
    const blob = `${item.title}. ${item.description || ''}`;
    for (const m of extractMentions(blob, item.source || 'Web')) {
      const key = `${m.type}:${m.label}`;
      if (!mentionMap.has(key)) {
        mentionMap.set(key, { ...m, count: 1, contexts: [item.title.slice(0, 80)] });
      } else {
        const ex = mentionMap.get(key);
        ex.count += 1;
        if (ex.contexts.length < 3) ex.contexts.push(item.title.slice(0, 80));
      }
    }
  }

  const mentions = [...mentionMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const progression = buildProgressionNarrative(timeline, story);
  const highlights = timeline
    .filter((t) => t.role === 'origin' || t.role === 'latest' || t.role === 'analysis')
    .slice(0, 5)
    .map((t) => ({
      headline: t.headline,
      source: t.source,
      publishedAt: t.publishedAt,
      role: t.role,
    }));

  return {
    headline,
    queriesUsed: queries,
    articleCount: timeline.length,
    timeline,
    mentions,
    highlights,
    progression,
    researchedAt: new Date().toISOString(),
    researchMs: Date.now() - started,
  };
}

/**
 * Build a daily brief from top stories + their research payloads.
 */
export function buildDailyBrief(stories, researches = []) {
  if (!stories?.length) return null;

  const allMentions = new Map();
  const allEvents = [];
  const themes = new Set();

  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    const r = researches[i];
    for (const lbl of s.themeLabels || []) themes.add(lbl);

    if (r?.mentions) {
      for (const m of r.mentions) {
        const key = m.label;
        allMentions.set(key, (allMentions.get(key) || 0) + (m.count || 1));
      }
    }
    if (r?.timeline) {
      for (const ev of r.timeline) {
        allEvents.push({
          ...ev,
          parentRank: s.rank,
          parentHeadline: s.headline || s.title,
        });
      }
    }
  }

  allEvents.sort((a, b) => new Date(a.publishedAt || 0) - new Date(b.publishedAt || 0));

  const topMentions = [...allMentions.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([label, count]) => ({ label, count }));

  const bullishScore = stories.reduce((sum, s) => sum + (s.platinumImpact || 0), 0);
  const direction =
    bullishScore >= 2 ? 'bullish' : bullishScore <= -2 ? 'bearish' : bullishScore !== 0 ? 'mixed' : 'neutral';

  const uniqueAngles = stories.map((s, i) => ({
    rank: s.rank,
    headline: s.headline || s.title,
    source: s.source,
    coverageDepth: researches[i]?.progression?.coverageDepth || 'unknown',
    articleCount: researches[i]?.articleCount || 0,
    direction: s.direction,
  }));

  const dayNarrative = (() => {
    const depths = researches.map((r) => r?.progression?.coverageDepth).filter(Boolean);
    const deepCount = depths.filter((d) => d === 'deep' || d === 'moderate').length;
    let intro = `Today's top ${stories.length} PGM stories were cross-checked against ${allEvents.length} related web articles. `;
    if (deepCount >= 2) {
      intro += 'Multiple threads have real multi-outlet traction — not recycled press-release noise. ';
    } else {
      intro += 'Coverage is thinner today — treat headlines as early signal until WPIC/producer commentary confirms. ';
    }
    if (topMentions.length) {
      intro += `Dominant mentions: ${topMentions.slice(0, 4).map((m) => m.label).join(', ')}. `;
    }
    if (direction === 'bullish') intro += 'Net narrative leans supportive for the PGM complex.';
    else if (direction === 'bearish') intro += 'Net narrative leans cautious for miners and PGM spot.';
    else if (direction === 'mixed') intro += 'Narrative is split — spot may decouple from equity moves.';
    else intro += 'No strong directional skew in today\'s web coverage.';
    return intro;
  })();

  const chronology = allEvents
    .slice(-12)
    .map((ev) => ({
      when: ev.publishedAt,
      headline: ev.headline,
      source: ev.source,
      tiedTo: ev.parentRank ? `#${ev.parentRank}` : null,
    }));

  return {
    direction,
    bullishScore,
    dayNarrative,
    topMentions,
    themes: [...themes],
    uniqueAngles,
    chronology,
    totalArticlesScanned: allEvents.length,
  };
}
