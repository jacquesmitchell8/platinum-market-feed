/**
 * Stooq CSV history downloader.
 *
 * Stooq now presents a JS proof-of-work "verify your browser" page to bots.
 * This module solves that PoW and returns the CSV response body.
 *
 * This is best-effort and may break if Stooq changes the challenge.
 */

import crypto from 'crypto';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function parseChallenge(html) {
  // Looks like:
  // const c="AAAA....",d=4,t="0".repeat(d)
  const mC = html.match(/const\s+c="([^"]+)"/);
  const mD = html.match(/,d=(\d+),t=/);
  if (!mC || !mD) return null;
  return { c: mC[1], d: parseInt(mD[1], 10) };
}

async function solvePow({ c, d }) {
  const prefix = '0'.repeat(d);
  // Brute force n until sha256(c+n) starts with prefix
  let n = 0;
  while (true) {
    const h = sha256Hex(c + n);
    if (h.startsWith(prefix)) return n;
    n++;
    if (n % 50000 === 0) await sleep(0); // yield
  }
}

function getCookiesFromResponse(res) {
  // Prefer undici/Node's getSetCookie() when available (multiple Set-Cookie headers).
  const anyHeaders = /** @type {any} */ (res.headers);
  const setCookies = typeof anyHeaders.getSetCookie === 'function' ? anyHeaders.getSetCookie() : [];
  const raw = setCookies.length ? setCookies : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const cookies = [];
  for (const sc of raw) {
    if (!sc) continue;
    const first = String(sc).split(';')[0];
    if (first) cookies.push(first);
  }
  return cookies;
}

export async function fetchStooqCsv({ symbol, interval = 'd', d1, d2 }) {
  const url = new URL('https://stooq.com/q/d/l/');
  url.searchParams.set('s', symbol);
  url.searchParams.set('i', interval);
  if (d1) url.searchParams.set('d1', d1);
  if (d2) url.searchParams.set('d2', d2);

  // 1) Try direct fetch (maybe already allowed)
  let res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  let body = await res.text();
  if (body.startsWith('Date,')) return body;

  // 2) Solve verify challenge if present
  const ch = parseChallenge(body);
  if (!ch) {
    throw new Error(`Stooq unexpected response (HTTP ${res.status})`);
  }

  const initialCookies = getCookiesFromResponse(res);
  const n = await solvePow(ch);
  const verifyUrl = new URL('https://stooq.com/__verify');
  const vRes = await fetch(verifyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0',
      Origin: 'https://stooq.com',
      Referer: 'https://stooq.com/',
      ...(initialCookies.length ? { Cookie: initialCookies.join('; ') } : {}),
    },
    body: `c=${encodeURIComponent(ch.c)}&n=${n}`,
  });
  const verifyCookies = getCookiesFromResponse(vRes);
  const cookieHeader = [...initialCookies, ...verifyCookies].filter(Boolean).join('; ');
  if (!vRes.ok || !cookieHeader) {
    throw new Error(`Stooq verify failed (HTTP ${vRes.status})`);
  }

  // 3) Re-fetch CSV with cookie
  await sleep(250);
  res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Cookie: cookieHeader,
      Referer: 'https://stooq.com/',
    },
  });
  body = await res.text();
  if (!res.ok) throw new Error(`Stooq CSV HTTP ${res.status}`);
  if (!body.startsWith('Date,')) {
    throw new Error(`Stooq did not return CSV after verify: ${body.slice(0, 120)}`);
  }
  return body;
}

