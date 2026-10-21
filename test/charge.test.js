import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/charge.js';
import { authnetApproved, authnetDeclined, installFetch, mockReq, mockRes, setEnv, validBody } from './helpers.js';

let net;
beforeEach(() => setEnv());
afterEach(() => net?.restore());

const run = async (body, reqOpts = {}) => {
  const res = mockRes();
  await handler(mockReq({ body, ...reqOpts }), res);
  return res;
};
const json = (o) => new Response(JSON.stringify(o), { status: 200 });
const find = (calls, s, method) => calls.find((c) => c.url.includes(s) && (!method || c.init.method === method));

test('approved: server recalculates total, calls sandbox Authorize.net, logs, returns confirmation', async () => {
  net = installFetch({ authnet: () => new Response('﻿' + JSON.stringify(authnetApproved), { status: 200 }) });
  // Browser lies about the totals; server must ignore them.
  const res = await run(validBody({ totalCharged: '1.00', convenienceFee: '0.00', total: '1.00' }));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true, transactionId: '60123456789', last4: '1111', cardType: 'Visa',
    invoiceAmount: '1000.00', convenienceFee: '30.00', totalCharged: '1030.00',
  });

  const an = find(net.calls, 'apitest.authorize.net');
  assert.ok(an, 'sandbox endpoint used');
  const req = JSON.parse(an.init.body).createTransactionRequest;
  assert.deepEqual(req.merchantAuthentication, { name: 'pwLogin', transactionKey: 'pwSecretTxnKey' });
  const t = req.transactionRequest;
  assert.equal(t.transactionType, 'authCaptureTransaction');
  assert.equal(t.amount, '1030.00');
  assert.deepEqual(t.payment.opaqueData, { dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT', dataValue: 'nonce-abc' });
  assert.equal(t.order.invoiceNumber, 'INV-1');
  assert.equal(t.order.description, 'Annual ad');
  assert.equal(t.customer.email, 'ada@example.com');
  assert.equal(t.billTo.firstName, 'Ada');
  assert.equal(t.customerIP, '203.0.113.9');

  const ins = find(net.calls, 'supabase.co', 'POST');
  const row = JSON.parse(ins.init.body);
  assert.equal(row.status, 'approved');
  assert.equal(row.environment, 'sandbox');
  assert.equal(row.total_charged, '1030.00');
  assert.equal(row.card_last4, '1111');
  assert.equal(row.authnet_transaction_id, '60123456789');
  assert.equal(row.ip_address, '203.0.113.9');
  const raw = ins.init.body;
  assert.equal(raw.includes('nonce-abc'), false, 'nonce not logged');
  assert.equal(raw.includes('ts-token'), false, 'turnstile token not logged');
  assert.equal(raw.includes('pwSecretTxnKey'), false);
});

test('declined: plain message, 402, logged as declined', async () => {
  net = installFetch({ authnet: () => json(authnetDeclined) });
  const res = await run(validBody());
  assert.equal(res.statusCode, 402);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'This transaction has been declined.');
  const row = JSON.parse(find(net.calls, 'supabase.co', 'POST').init.body);
  assert.equal(row.status, 'declined');
  assert.equal(row.authnet_transaction_id, '60123456790');
});

test('gateway credential errors are not leaked to the customer', async () => {
  net = installFetch({
    authnet: () => json({ messages: { resultCode: 'Error', message: [{ code: 'E00007', text: 'User authentication failed due to invalid authentication values.' }] } }),
  });
  const res = await run(validBody());
  assert.equal(res.statusCode, 502);
  assert.equal(/authentication/i.test(res.body.error), false);
  assert.equal(JSON.parse(find(net.calls, 'supabase.co', 'POST').init.body).status, 'error');
});

test('Authorize.net outage: error logged, customer told not to blindly retry', async () => {
  net = installFetch({ authnet: () => { throw new Error('boom'); } });
  const res = await run(validBody());
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /do not submit again/i);
});

test('invoice number over 20 chars: truncated for Authorize.net, full value kept in description and log', async () => {
  net = installFetch();
  const long = 'INV-2026-ABCDEFGHIJKLMNOP';
  await run(validBody({ invoiceNumber: long }));
  const t = JSON.parse(find(net.calls, 'authorize.net').init.body).createTransactionRequest.transactionRequest;
  assert.equal(t.order.invoiceNumber, long.slice(0, 20));
  assert.ok(t.order.description.includes(long));
  assert.equal(JSON.parse(find(net.calls, 'supabase.co', 'POST').init.body).invoice_number, long);
});

test('rejections never reach Authorize.net', async () => {
  net = installFetch();
  const cases = [
    [validBody({ account: 'nope' }), 400],
    [validBody({ invoiceAmount: 'abc' }), 400],
    [validBody({ agreed: false }), 400],
    [validBody({ hb_contact_pref: 'bot@spam' }), 400],
    [validBody({ expectedTotal: '1.00' }), 409],
    [validBody({ chargeDescription: '4111 1111 1111 1111' }), 400],
  ];
  for (const [body, status] of cases) {
    const res = await run(body);
    assert.equal(res.statusCode, status, JSON.stringify(res.body));
  }
  assert.equal((await run(validBody(), { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await run(undefined)).statusCode, 400);
  const resGet = mockRes();
  await handler(mockReq({ method: 'GET' }), resGet);
  assert.equal(resGet.statusCode, 405);
  assert.equal(find(net.calls, 'authorize.net'), undefined);
});

test('matching expectedTotal is accepted', async () => {
  net = installFetch();
  assert.equal((await run(validBody({ expectedTotal: '1030.00' }))).statusCode, 200);
});

test('Turnstile failure blocks the charge', async () => {
  net = installFetch({ turnstile: () => json({ success: false, 'error-codes': ['invalid-input-response'] }) });
  const res = await run(validBody());
  assert.equal(res.statusCode, 400);
  assert.equal(find(net.calls, 'authorize.net'), undefined);
});

test('rate limit: 6th attempt from an IP within the window is refused', async () => {
  net = installFetch();
  for (let i = 0; i < 5; i++) assert.equal((await run(validBody())).statusCode, 200);
  const res = await run(validBody());
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '600');
  // a different IP is unaffected
  assert.equal((await run(validBody(), { ip: '198.51.100.7' })).statusCode, 200);
});

test('rate limit: durable count from Supabase applies across instances', async () => {
  net = installFetch({ count: () => new Response(null, { status: 200, headers: { 'content-range': '0-0/5' } }) });
  assert.equal((await run(validBody())).statusCode, 429);
  assert.equal(find(net.calls, 'authorize.net'), undefined);
});

test('fails closed (503) if the log store is unreachable', async () => {
  net = installFetch({ count: () => new Response(null, { status: 500 }) });
  assert.equal((await run(validBody())).statusCode, 503);
  assert.equal(find(net.calls, 'authorize.net'), undefined);
});

test('a failed log write does not turn an approved charge into a failure', async () => {
  net = installFetch({ insert: () => new Response('nope', { status: 500 }) });
  const res = await run(validBody());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});
