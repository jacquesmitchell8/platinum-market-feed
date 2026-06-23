// Paginated Supabase reads — PostgREST defaults to max 1000 rows per request.

export const PAGE_SIZE = 1000;

export async function sbFetchAll(supabaseUrl, key, path, pageSize = PAGE_SIZE) {
  const out = [];
  let from = 0;
  while (true) {
    const to = from + pageSize - 1;
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Range: `${from}-${to}`,
      },
    });
    if (!res.ok) throw new Error(`Supabase read failed: ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

export async function sbCount(supabaseUrl, key, table, filter) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=recorded_day&${filter}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  const range = res.headers.get('content-range') || '';
  const m = range.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}
