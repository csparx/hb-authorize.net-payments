// Rate limit for /api/charge: 5 attempts per IP per 10 minutes.
//  - In-memory sliding window: cheap first line, per warm serverless instance.
//  - Supabase count of logged attempts: durable across instances/cold starts.

import { countRecentByIp } from './supabase.js';

export const MAX_ATTEMPTS = 5;
export const WINDOW_MS = 10 * 60 * 1000;

const hits = new Map(); // ip -> [timestamps]

function recent(ip, now) {
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) hits.set(ip, list);
  else hits.delete(ip);
  return list;
}

export function resetRateLimit() {
  hits.clear();
}

/**
 * Returns { limited: boolean }. Throws if the durable store can't be read
 * (caller fails closed: we won't take payments we can't audit).
 */
export async function checkRateLimit(ip, deps = {}) {
  const now = Date.now();
  if (recent(ip, now).length >= MAX_ATTEMPTS) return { limited: true };

  const since = new Date(now - WINDOW_MS).toISOString();
  const logged = await countRecentByIp(ip, since, deps);
  if (logged >= MAX_ATTEMPTS) return { limited: true };

  hits.set(ip, [...recent(ip, now), now]);
  return { limited: false };
}
