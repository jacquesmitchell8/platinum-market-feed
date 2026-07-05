/**
 * Platinum Metis — technical pattern library (our own theory copy).
 * Seeded into Supabase ta_pattern_library; also used as fallback if DB empty.
 */

export const TA_PATTERNS = [
  {
    slug: 'inverted_cup',
    title: 'Inverted cup & handle (bearish)',
    bias: 'bearish',
    aliases: ['inv_left', 'inv_bottom', 'inv_right'],
    summary: 'An inverted U-shaped distribution: price forms two similar highs (rims) with a rounded base between them. Break below the neckline often signals distribution completing.',
    theory: `The inverted cup is the bearish mirror of the classic cup-and-handle. Price rallies to a rim, pulls back in a rounded base, then retests the rim zone. When the second rim fails to break higher and price slips under the neckline (the average of the two rims), sellers who accumulated during the base often accelerate the move down.

**What we watch on Metis curves:** rim symmetry (within ~4%), base depth (typically 3.5–22% of rim), and whether live spot is still above or below the neckline. Platinum and PGM names often form these structures over multi-month consolidations when auto demand headlines fade but supply deficits haven't yet repriced spot.

**Not a guarantee** — macro shocks (USD, SA power, ETF flows) can invalidate the pattern. Use alongside WPIC balance and stock cover, not in isolation.`,
    diagram: 'inverted_cup',
  },
  {
    slug: 'double_top',
    title: 'Double top',
    bias: 'bearish',
    aliases: ['double_top'],
    summary: 'Two distinct peaks at similar levels with a trough between. A close below the neckline (intervening low) suggests trend exhaustion.',
    theory: `A double top marks failed continuation: buyers push price to a high twice but cannot sustain it. The neckline is the lowest point between the two peaks. A breakdown through that level implies the second attempt to break out has failed and prior support may now act as resistance.

**Metis read:** On platinum spot or JSE producers, double tops often coincide with "good news priced in" — e.g. deficit headlines while price stalls. Measure depth from peaks to neckline; deeper patterns (>2%) tend to have more follow-through once broken.

**False signals:** noisy intraday spikes on thin crypto curves can mimic double tops — prefer daily closes and longer timeframes (3m+) for PGM.`,
    diagram: 'double_top',
  },
  {
    slug: 'double_bottom',
    title: 'Double bottom',
    bias: 'bullish',
    aliases: ['double_bottom'],
    summary: 'Two lows at similar levels with a peak between. Break above the neckline suggests accumulation completing.',
    theory: `The double bottom is the bullish counterpart to the double top: sellers exhaust twice at a similar zone, then price reclaims the neckline (high between the lows). It often marks the end of a correction when fundamental support (deficit, cover) is improving but price lagged.

**Metis read:** On CFX or platinum, look for the second low to hold on similar or lighter volume (we infer from curve shape — less violent spike). Reclaim of neckline with spot still below major resistance is an accumulate signal, not automatic breakout.

**Caution:** In sustained bear markets, double bottoms can fail into triple bottoms or lower lows — always check cumulative scarcity and news progression.`,
    diagram: 'double_bottom',
  },
  {
    slug: 'breakout',
    title: 'Resistance breakout',
    bias: 'bullish',
    aliases: ['breakout'],
    summary: 'Price closes materially above a clustered resistance level — prior sellers may be trapped.',
    theory: `Resistance is a price zone where prior supply repeatedly capped rallies. A breakout occurs when price clears that cluster by a meaningful margin (Metis uses ~0.35% beyond the level on daily data). The move implies new demand absorbed overhead supply.

**Metis read:** On platinum, breakouts above multi-month highs often lag WPIC deficit data — spot catches up when cover tightens. On crypto, breakouts need confirmation; false breaks are common on low-liquidity alts like CFX.

**Follow-through:** Retest of broken resistance as support is the classic confirmation. Without it, treat as a range extension, not a new trend.`,
    diagram: 'breakout',
  },
  {
    slug: 'breakdown',
    title: 'Support breakdown',
    bias: 'bearish',
    aliases: ['breakdown'],
    summary: 'Price closes materially below a support cluster — prior buyers may be underwater.',
    theory: `Support clusters form where demand repeatedly absorbed selloffs. A breakdown means that floor failed; stops and forced selling can accelerate the move. Metis flags breakdowns when price crosses ~0.35% below the support pivot cluster.

**Metis read:** PGM breakdowns during risk-off macro often overshoot fair value before deficit narrative reasserts. JSE producer breakdowns can lead spot when equity discounts SA operational risk.

**Risk:** Dead-cat bounces are common — check whether breakdown aligns with rising stock cover or ETF outflows before sizing.`,
    diagram: 'breakdown',
  },
  {
    slug: 'support',
    title: 'Support cluster',
    bias: 'neutral',
    aliases: [],
    summary: 'Horizontal zone where price repeatedly found buyers — potential entry area if held.',
    theory: `Support is not a single line but a cluster of pivot lows within ~1.8% of each other. Metis draws the two strongest clusters below current price. These levels often map to prior consolidation floors, round numbers, or post-breakout retests.

**How we use it:** Scale-in zones for accumulate verdicts when spot approaches support with constructive fundamentals. A break below invalidates the cluster.

**Platinum-specific:** Support often aligns with Pt/Au ratio compression zones and Perth coin premium extremes.`,
    diagram: 'support',
  },
  {
    slug: 'resistance',
    title: 'Resistance cluster',
    bias: 'neutral',
    aliases: [],
    summary: 'Horizontal zone where rallies repeatedly stalled — overhead supply until cleared.',
    theory: `Resistance clusters are pivot highs where supply repeatedly capped price. Until cleared, rallies into resistance are sell-the-rip candidates unless fundamentals are accelerating (deficit shock, cover sub-3 months).

**Metis read:** Layer resistance with annual WPIC deficit narrative — price can stall at resistance even in deficit if ETF investment segment is selling.

**Breakout link:** See resistance breakout when price clears this zone with margin.`,
    diagram: 'resistance',
  },
];

export function patternBySlug(slug) {
  return TA_PATTERNS.find((p) => p.slug === slug) || null;
}

export function slugForMarker(marker) {
  if (!marker) return null;
  if (marker.startsWith('inv')) return 'inverted_cup';
  if (marker === 'double_top' || marker === 'double_bottom') return marker;
  if (marker === 'breakout' || marker === 'breakdown') return marker;
  return null;
}

/** Build our own event narrative from detection context — stored in Supabase. */
export function buildObservationStory(pattern, ctx) {
  const { assetLabel, timeframe, detectedAt, levels, dates, bias, livePrice } = ctx;
  const when = dates?.start ? new Date(dates.start).toLocaleDateString([], { month: 'short', year: 'numeric' }) : 'recent session';
  const whenEnd = dates?.end ? new Date(dates.end).toLocaleDateString([], { month: 'short', year: 'numeric' }) : when;

  const parts = [
    `**${assetLabel} · ${timeframe}** — Metis flagged **${pattern.title}** (${when}${whenEnd !== when ? ` – ${whenEnd}` : ''}).`,
  ];

  if (pattern.slug === 'inverted_cup' && levels?.neckline) {
    parts.push(`Rim/neckline near **${levels.neckline}**; depth **${levels.depthPct || '?'}%**. Live **${livePrice ?? '—'}** ${livePrice && levels.neckline && livePrice < levels.neckline ? 'is below neckline — bearish structure intact' : 'still above neckline — pattern not yet confirmed down'}.`);
  } else if ((pattern.slug === 'double_top' || pattern.slug === 'double_bottom') && levels?.neckline) {
    parts.push(`Neckline **${levels.neckline}**; pattern depth **${levels.depthPct || '?'}%**. Price ${livePrice && levels.neckline ? (pattern.slug === 'double_bottom' && livePrice > levels.neckline ? 'has reclaimed neckline (bullish follow-through watch)' : pattern.slug === 'double_top' && livePrice < levels.neckline ? 'below neckline (distribution risk)' : 'inside pattern — await break') : 'tracked on curve'}.`);
  } else if (pattern.slug === 'breakout' && levels?.level) {
    parts.push(`Cleared resistance near **${levels.level}** — prior cap may flip to support on retest.`);
  } else if (pattern.slug === 'breakdown' && levels?.level) {
    parts.push(`Lost support near **${levels.level}** — monitor for dead-cat bounce vs continuation.`);
  } else if (levels?.support || levels?.resistance) {
    parts.push(`Nearest support **${levels.support ?? '—'}** · resistance **${levels.resistance ?? '—'}**.`);
  }

  parts.push(`Structural bias on this timeframe: **${bias || 'neutral'}**. This observation is generated from Metis pivot/heuristic detection — cross-check with WPIC balance, stock cover, and news progression before acting.`);

  return parts.join('\n\n');
}
