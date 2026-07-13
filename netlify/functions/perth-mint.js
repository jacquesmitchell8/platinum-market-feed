// netlify/functions/perth-mint.js
//
// LIVE Perth Mint AUD metal prices — single source of truth for Face Value melt.
//
// Live spot:  GET https://www.perthmint.com/api/bullion/bullion-slots
// History:    GET https://www.perthmint.com/api/exchangerate/metal/retail/pricehistory
//
// No USD→AUD conversion. No synthetic spreads. Numbers are Perth Mint AUD.

const PM_UA = 'Mozilla/5.0 (compatible; PlatinumMetis/1.0; +https://platinum-conflux.netlify.app)';
const SLOTS_URL = 'https://www.perthmint.com/api/bullion/bullion-slots';
const HISTORY_URL = 'https://www.perthmint.com/api/exchangerate/metal/retail/pricehistory';

function parseAudValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const n = Number(String(raw).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function audFromPricing(pricing, currency = 'AUD') {
  const hit = (pricing || []).find((p) => String(p.currency).toUpperCase() === currency);
  return parseAudValue(hit?.value);
}

function mapHistoryPoint(p) {
  const ts = Date.parse(p.dateTime || p.timestamp || 0);
  return {
    timestamp: Number.isFinite(ts) ? ts : Date.now(),
    dateTime: p.dateTime || null,
    offer: Number(p.offer),
    mid: Number(p.mid),
    bid: Number(p.bid),
    estimated: false,
  };
}

function sliceHistory(points, n) {
  if (!points?.length) return [];
  return points.slice(-n);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': PM_UA,
      Accept: 'application/json',
      Referer: 'https://www.perthmint.com/invest/information-for-investors/metal-prices/',
    },
  });
  if (!res.ok) throw new Error(`Perth Mint ${res.status} for ${url}`);
  return res.json();
}

export default async () => {
  try {
    const [slots, history] = await Promise.all([
      fetchJson(SLOTS_URL),
      fetchJson(HISTORY_URL).catch(() => null),
    ]);

    const prices = slots?.result?.data?.prices || [];
    const goldLive = audFromPricing(prices.find((p) => p.metal === 'Gold')?.pricing);
    const platLive = audFromPricing(prices.find((p) => p.metal === 'Platinum')?.pricing);
    const silverLive = audFromPricing(prices.find((p) => p.metal === 'Silver')?.pricing);

    if (goldLive == null && platLive == null) {
      throw new Error('Perth Mint bullion-slots returned no AUD prices');
    }

    const histByMetal = {};
    for (const m of history?.result || []) {
      if (!m?.metal || m.currency !== 'AUD') continue;
      const week = (m.oneWeekHistoricData || []).map(mapHistoryPoint).filter((p) => Number.isFinite(p.mid));
      const two = (m.twoYearsHistoricData || m.oneWeekHistoricData || []).map(mapHistoryPoint).filter((p) => Number.isFinite(p.mid));
      histByMetal[m.metal] = { week, two };
    }

    // Ensure live slot is the tip of each history series (same AUD source).
    const stampLive = (metal, liveAud, hist) => {
      const tip = {
        timestamp: Date.parse(slots?.result?.slot) || Date.now(),
        dateTime: slots?.result?.slot || new Date().toISOString(),
        offer: liveAud,
        mid: liveAud,
        bid: liveAud,
        estimated: false,
        liveSlot: true,
      };
      const week = [...(hist?.week || [])];
      const two = [...(hist?.two || hist?.week || [])];
      if (liveAud != null) {
        week.push(tip);
        two.push(tip);
      }
      return {
        metal,
        currency: 'AUD',
        estimated: false,
        liveAud: liveAud ?? null,
        oneWeekHistoricData: sliceHistory(week, 200),
        twoYearsHistoricData: sliceHistory(two, 2000),
        threeYearsHistoricData: sliceHistory(two, 3000),
        fiveYearsHistoricData: sliceHistory(two, 5000),
      };
    };

    const goldEntry = stampLive('Gold', goldLive, histByMetal.Gold);
    const platEntry = stampLive('Platinum', platLive, histByMetal.Platinum);
    const silverEntry = stampLive('Silver', silverLive, histByMetal.Silver);

    return new Response(JSON.stringify({
      ok: true,
      estimated: false,
      source: 'perthmint.com/api/bullion/bullion-slots',
      historySource: history ? 'perthmint.com/api/exchangerate/metal/retail/pricehistory' : null,
      updatedAt: slots?.result?.slot || new Date().toISOString(),
      buyingOpen: !!slots?.result?.data?.buyingOpen,
      // Canonical Face Value spots — AUD per troy oz, no FX
      liveSpotAud: {
        gold: goldLive,
        platinum: platLive,
        silver: silverLive,
      },
      result: [goldEntry, platEntry, silverEntry].filter((e) => e.liveAud != null || e.oneWeekHistoricData?.length),
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok: false,
      error: err.message || 'Perth Mint fetch failed',
      estimated: true,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
