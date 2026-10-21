import { resetRateLimit } from '../lib/ratelimit.js';

export const ENV = {
  AUTHNET_SANDBOX_MODE: 'true',
  AUTHNET_SANDBOX_PW_LOGIN_ID: 'pwLogin',
  AUTHNET_SANDBOX_PW_TXN_KEY: 'pwSecretTxnKey',
  AUTHNET_SANDBOX_PW_CLIENT_KEY: 'pwClientKey',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  TURNSTILE_SECRET_KEY: 'ts-secret',
  TURNSTILE_SITE_KEY: 'ts-site',
};

export function setEnv(extra = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith('AUTHNET_') || k === 'VERCEL_ENV') delete process.env[k];
  Object.assign(process.env, ENV, extra);
  resetRateLimit();
}

export function mockRes() {
  const res = {
    headers: {},
    statusCode: 200,
    body: undefined,
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.ended = true; return this; },
    end() { this.ended = true; return this; },
  };
  return res;
}

export function mockReq({ method = 'POST', origin = 'https://hattonbrown.net', body, query = {}, ip = '203.0.113.9' } = {}) {
  return { method, headers: { origin, 'x-real-ip': ip }, body, query };
}

export const validBody = (over = {}) => ({
  account: 'pw',
  firstName: 'Ada',
  lastName: 'Lovelace',
  company: 'Analytical Engines Inc',
  phone: '+44 20 7946 0958',
  email: 'ada@example.com',
  invoiceAmount: '1000.00',
  invoiceNumber: 'INV-1',
  chargeDescription: 'Annual ad',
  signatureName: 'Ada Lovelace',
  agreed: true,
  cardType: 'Visa',
  opaqueData: { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'nonce-abc' },
  turnstileToken: 'ts-token',
  ...over,
});

export const authnetApproved = {
  transactionResponse: {
    responseCode: '1', authCode: 'ABC123', transId: '60123456789', accountNumber: 'XXXX1111', accountType: 'Visa',
    messages: [{ code: '1', description: 'This transaction has been approved.' }],
  },
  messages: { resultCode: 'Ok', message: [{ code: 'I00001', text: 'Successful.' }] },
};
export const authnetDeclined = {
  transactionResponse: {
    responseCode: '2', transId: '60123456790', accountNumber: 'XXXX0002', accountType: 'Visa',
    errors: [{ errorCode: '2', errorText: 'This transaction has been declined.' }],
  },
  messages: { resultCode: 'Error', message: [{ code: 'E00027', text: 'The transaction was unsuccessful.' }] },
};

/**
 * Installs a fake global fetch. Returns { calls, restore }.
 * overrides: { turnstile, authnet, insert, count } each a function returning a Response-ish or a status.
 */
export function installFetch(overrides = {}) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers });
    if (u.includes('challenges.cloudflare.com')) return overrides.turnstile?.(init) ?? json({ success: true });
    if (u.includes('authorize.net')) return overrides.authnet?.(init) ?? json(authnetApproved);
    if (u.includes('supabase.co') && init.method === 'HEAD') {
      return overrides.count?.(init) ?? new Response(null, { status: 200, headers: { 'content-range': '*/0' } });
    }
    if (u.includes('supabase.co')) return overrides.insert?.(init) ?? new Response(null, { status: 201 });
    throw new Error(`unexpected fetch ${u}`);
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
