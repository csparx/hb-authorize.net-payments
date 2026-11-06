// Minimal Supabase PostgREST client (service role, server-side only). No SDK dependency.

const TABLE = 'payment_transactions';

function conf(env) {
  const url = env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase is not configured');
  return {
    base: `${url}/rest/v1/${TABLE}`,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  };
}

/** Inserts a row and returns its id (null if the response carried none). */
export async function insertTransaction(row, { env = process.env, fetchImpl = fetch } = {}) {
  const { base, headers } = conf(env);
  const resp = await fetchImpl(`${base}?select=id`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Supabase insert failed: HTTP ${resp.status}`);
  try {
    return (await resp.json())?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function updateTransaction(id, patch, { env = process.env, fetchImpl = fetch } = {}) {
  const { base, headers } = conf(env);
  const resp = await fetchImpl(`${base}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Supabase update failed: HTTP ${resp.status}`);
}

/** Number of logged attempts from this IP since `sinceIso`. */
export async function countRecentByIp(ip, sinceIso, { env = process.env, fetchImpl = fetch } = {}) {
  const { base, headers } = conf(env);
  const qs = new URLSearchParams({ select: 'id', ip_address: `eq.${ip}`, created_at: `gte.${sinceIso}` });
  const resp = await fetchImpl(`${base}?${qs}`, {
    method: 'HEAD',
    headers: { ...headers, Prefer: 'count=exact', Range: '0-0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Supabase count failed: HTTP ${resp.status}`);
  const total = /\/(\d+)$/.exec(resp.headers.get('content-range') || '')?.[1];
  if (total == null) throw new Error('Supabase count missing content-range');
  return Number(total);
}
