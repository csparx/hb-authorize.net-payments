// Server-side verification of the Cloudflare Turnstile token.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(token, ip, { env = process.env, fetchImpl = fetch } = {}) {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: false, reason: 'not_configured' };
  const form = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'unknown') form.set('remoteip', ip);
  try {
    const resp = await fetchImpl(VERIFY_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(8000) });
    const json = await resp.json();
    return json.success ? { ok: true } : { ok: false, reason: (json['error-codes'] || []).join(',') || 'failed' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
