// GET /api/config?account=pw  ->  { apiLoginId, clientKey, environment, turnstileSiteKey }
// apiLoginId + clientKey are public by design (Accept.js needs them). The transaction key is never returned.

import { getAccount, isAllowedAccount } from '../lib/accounts.js';
import { applyCors, sendJson } from '../lib/http.js';

export default function handler(req, res) {
  const cors = applyCors(req, res, 'GET');

  if (req.method === 'OPTIONS') {
    res.status(cors.allowed ? 204 : 403).end();
    return;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  if (cors.origin && !cors.allowed) return sendJson(res, 403, { error: 'Origin not allowed.' });

  const code = Array.isArray(req.query?.account) ? req.query.account[0] : req.query?.account;
  if (!isAllowedAccount(code)) return sendJson(res, 400, { error: 'Invalid account.' });

  const account = getAccount(code);
  if (!account) {
    console.error(`config: account "${code}" is not fully configured`);
    return sendJson(res, 500, { error: 'This payment account is not available right now.' });
  }

  return sendJson(res, 200, {
    apiLoginId: account.loginId,
    clientKey: account.clientKey,
    environment: account.environment,
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null,
  });
}
