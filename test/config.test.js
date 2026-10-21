import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/config.js';
import { mockReq, mockRes, setEnv } from './helpers.js';

beforeEach(() => setEnv());

test('returns public keys only for an allowed, configured account', () => {
  const res = mockRes();
  handler(mockReq({ method: 'GET', query: { account: 'pw' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { apiLoginId: 'pwLogin', clientKey: 'pwClientKey', environment: 'sandbox', turnstileSiteKey: 'ts-site' });
  assert.equal(JSON.stringify(res.body).includes('pwSecretTxnKey'), false);
  assert.equal(res.headers['access-control-allow-origin'], 'https://hattonbrown.net');
});

test('rejects unknown accounts and unconfigured accounts', () => {
  let res = mockRes();
  handler(mockReq({ method: 'GET', query: { account: 'evil' } }), res);
  assert.equal(res.statusCode, 400);
  res = mockRes();
  handler(mockReq({ method: 'GET', query: { account: 'hb' } }), res); // no HB creds in env
  assert.equal(res.statusCode, 500);
});

test('uses live credentials when sandbox mode is off', () => {
  setEnv({ AUTHNET_SANDBOX_MODE: 'false', AUTHNET_PW_LOGIN_ID: 'liveL', AUTHNET_PW_TXN_KEY: 'liveT', AUTHNET_PW_CLIENT_KEY: 'liveC' });
  const res = mockRes();
  handler(mockReq({ method: 'GET', query: { account: 'pw' } }), res);
  assert.equal(res.body.apiLoginId, 'liveL');
  assert.equal(res.body.environment, 'live');
});

test('CORS: disallowed origin blocked, preflight answered, localhost only outside production', () => {
  let res = mockRes();
  handler(mockReq({ method: 'GET', origin: 'https://evil.example', query: { account: 'pw' } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers['access-control-allow-origin'], undefined);

  res = mockRes();
  handler(mockReq({ method: 'OPTIONS', origin: 'https://www.hattonbrown.net' }), res);
  assert.equal(res.statusCode, 204);

  res = mockRes();
  handler(mockReq({ method: 'GET', origin: 'http://localhost:8080', query: { account: 'pw' } }), res);
  assert.equal(res.statusCode, 200);

  setEnv({ VERCEL_ENV: 'production' });
  res = mockRes();
  handler(mockReq({ method: 'GET', origin: 'http://localhost:8080', query: { account: 'pw' } }), res);
  assert.equal(res.statusCode, 403);
});
