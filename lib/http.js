// CORS, body parsing and client-IP helpers shared by the API routes.

const PROD_ORIGINS = ['https://hattonbrown.net', 'https://www.hattonbrown.net'];

export function isProduction(env = process.env) {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === 'production';
  return env.NODE_ENV === 'production';
}

export function allowedOrigins(env = process.env) {
  if (isProduction(env)) return PROD_ORIGINS;
  return [...PROD_ORIGINS, env.LOCAL_DEV_ORIGIN || 'http://localhost:8080'];
}

/** Sets CORS headers when the request Origin is allowed. Returns { origin, allowed }. */
export function applyCors(req, res, methods, env = process.env) {
  const origin = req.headers.origin;
  const allowed = typeof origin === 'string' && allowedOrigins(env).includes(origin);
  res.setHeader('Vary', 'Origin');
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', `${methods}, OPTIONS`);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  return { origin, allowed };
}

export function sendJson(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

export function parseBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') {
    try {
      const parsed = JSON.parse(b);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function clientIp(req) {
  const h = req.headers;
  const raw = h['x-vercel-forwarded-for'] || h['x-real-ip'] || h['x-forwarded-for'] || '';
  const first = String(raw).split(',')[0].trim();
  return first || req.socket?.remoteAddress || 'unknown';
}
