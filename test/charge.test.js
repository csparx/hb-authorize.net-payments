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
    ok: true, transactionId: '60123456789', last4: '1111', cardType: 'Visa', cardFunding: 'credit',
    invoiceAmount: '1000.00', convenienceFee: '30.00', totalCharged: '1030.00', receiptEmailSent: true,
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

// ---- Section 6: emails (Resend) ----

const emailCalls = (calls) => calls.filter((c) => c.url.includes('api.resend.com')).map((c) => ({ ...c, json: JSON.parse(c.init.body) }));

test('approved: sends customer receipt + internal notification, then records the flags', async () => {
  net = installFetch();
  const res = await run(validBody({ company: 'Acme Panels' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.receiptEmailSent, true);

  const [receipt, internal] = emailCalls(net.calls);
  assert.deepEqual(receipt.json.to, ['ada@example.com']);
  assert.equal(receipt.init.headers.Authorization, 'Bearer re_test');
  assert.equal(receipt.init.headers['Idempotency-Key'], 'receipt-60123456789');
  for (const needle of ['Acme Panels', 'INV-1', 'Annual ad', '$1,000.00', '$30.00', '$1,030.00', 'Visa ending in 1111', '60123456789']) {
    assert.ok(receipt.json.html.includes(needle), `receipt html has ${needle}`);
    assert.ok(receipt.json.text.includes(needle), `receipt text has ${needle}`);
  }

  assert.deepEqual(internal.json.to, ['hbcc@hattonbrown.com']);
  assert.equal(internal.json.subject, '[SANDBOX] [PW] Payment received — $1,030.00 — Acme Panels');
  assert.equal(internal.json.reply_to, 'ada@example.com');
  for (const needle of ['Ada Lovelace', '+44 20 7946 0958', 'ada@example.com', 'sandbox']) {
    assert.ok(internal.json.html.includes(needle), `internal html has ${needle}`);
  }

  const patch = find(net.calls, 'supabase.co', 'PATCH');
  assert.ok(patch.url.includes('id=eq.row-1'));
  assert.deepEqual(JSON.parse(patch.init.body), { receipt_email_sent: true, internal_email_sent: true });
});

test('live-mode internal subject matches the spec exactly (no sandbox tag)', async () => {
  setEnv({ AUTHNET_SANDBOX_MODE: 'false', AUTHNET_PW_LOGIN_ID: 'l', AUTHNET_PW_TXN_KEY: 't', AUTHNET_PW_CLIENT_KEY: 'c' });
  net = installFetch();
  await run(validBody({ company: 'Acme Panels' }));
  assert.equal(emailCalls(net.calls)[1].json.subject, '[PW] Payment received — $1,030.00 — Acme Panels');
});

test('SANDBOX_NOTIFY_EMAIL redirects internal mail in sandbox only', async () => {
  setEnv({ SANDBOX_NOTIFY_EMAIL: 'me@example.com, you@example.com' });
  net = installFetch();
  await run(validBody());
  assert.deepEqual(emailCalls(net.calls)[1].json.to, ['me@example.com', 'you@example.com']);
});

test('customer-supplied text is HTML-escaped and cannot inject subject lines', async () => {
  net = installFetch();
  await run(validBody({ company: 'Evil<script>alert(1)</script>\nBcc: x@y.z', chargeDescription: '<img src=x onerror=alert(1)>' }));
  const [receipt, internal] = emailCalls(net.calls);
  assert.equal(receipt.json.html.includes('<script>'), false);
  assert.equal(receipt.json.html.includes('<img'), false);
  assert.ok(receipt.json.html.includes('&lt;script&gt;'));
  assert.equal(/[\r\n]/.test(internal.json.subject), false);
});

test('no emails for declined or errored payments', async () => {
  net = installFetch({ authnet: () => json(authnetDeclined) });
  await run(validBody());
  assert.equal(emailCalls(net.calls).length, 0);
});

test('email failure never affects the approved response; flags stay false', async () => {
  net = installFetch({ resend: () => new Response('{"message":"nope"}', { status: 422 }) });
  const res = await run(validBody());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.receiptEmailSent, false);
  assert.equal(find(net.calls, 'supabase.co', 'PATCH'), undefined);
});

test('one email failing does not stop the other', async () => {
  let n = 0;
  net = installFetch({ resend: () => (++n === 1 ? new Response('x', { status: 422 }) : json({ id: 'ok' })) });
  await run(validBody());
  assert.deepEqual(JSON.parse(find(net.calls, 'supabase.co', 'PATCH').init.body), { receipt_email_sent: false, internal_email_sent: true });
});

test('a 429 from Resend is retried once with the same idempotency key', async () => {
  let n = 0;
  net = installFetch({ resend: () => (++n === 1 ? new Response('slow down', { status: 429 }) : json({ id: 'ok' })) });
  const res = await run(validBody());
  assert.equal(res.body.receiptEmailSent, true);
  const calls = emailCalls(net.calls);
  assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key']);
});

test('missing Resend config: charge still succeeds, nothing sent', async () => {
  setEnv();
  delete process.env.RESEND_API_KEY;
  net = installFetch();
  const res = await run(validBody());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.receiptEmailSent, false);
  assert.equal(emailCalls(net.calls).length, 0);
});

test('internal subject labels the Expo account HBE; other accounts keep their codes', async () => {
  const { buildInternal, accountLabel } = await import('../lib/emailTemplates.js');
  assert.deepEqual(['hb', 'pw', 'expo', 'pwshow'].map(accountLabel), ['HB', 'PW', 'HBE', 'PWSHOW']);
  const base = { environment: 'live', values: { company: 'Acme', firstName: 'A', lastName: 'B' }, amounts: { invoiceAmount: '1.00', convenienceFee: '0.03', totalCharged: '1.03' }, date: new Date(), cardType: 'Visa', last4: '1111', transactionId: '1' };
  assert.equal(buildInternal({ ...base, account: 'expo' }).subject, '[HBE] Payment received — $1.03 — Acme');
});

// ---- Debit cards: no convenience fee ----

const sentAmount = (calls) => JSON.parse(find(calls, 'authorize.net').init.body).createTransactionRequest.transactionRequest.amount;

test('debit: no fee is charged, logged, returned, or emailed', async () => {
  net = installFetch();
  const res = await run(validBody({ cardFunding: 'debit', expectedTotal: '1000.00' }));
  assert.equal(res.statusCode, 200);
  assert.equal(sentAmount(net.calls), '1000.00');
  assert.equal(res.body.convenienceFee, '0.00');
  assert.equal(res.body.totalCharged, '1000.00');
  assert.equal(res.body.cardFunding, 'debit');
  const row = JSON.parse(find(net.calls, 'supabase.co', 'POST').init.body);
  assert.equal(row.convenience_fee, '0.00');
  assert.equal(row.total_charged, '1000.00');
  assert.equal(row.card_type, 'Visa (debit)');
  const [receipt, internal] = emailCalls(net.calls);
  assert.ok(receipt.json.html.includes('no fee on debit cards'));
  assert.ok(receipt.json.html.includes('Visa debit ending in 1111'));
  assert.equal(internal.json.subject, '[SANDBOX] [PW] Payment received — $1,000.00 — Analytical Engines Inc');
});

test('credit (explicit, missing, or junk cardFunding) still pays the 3% fee', async () => {
  for (const cardFunding of ['credit', undefined, 'prepaid', 'DEBIT', 7, null]) {
    setEnv();
    net = installFetch();
    const res = await run(validBody({ cardFunding }));
    assert.equal(res.statusCode, 200, String(cardFunding));
    assert.equal(sentAmount(net.calls), '1030.00', String(cardFunding));
    assert.equal(res.body.cardFunding, 'credit');
    assert.equal(JSON.parse(find(net.calls, 'supabase.co', 'POST').init.body).card_type, 'Visa');
    net.restore();
  }
});

test('the total the customer saw must match the card type: a credit total with debit funding (or vice versa) is refused before any charge', async () => {
  net = installFetch();
  let res = await run(validBody({ cardFunding: 'debit', expectedTotal: '1030.00' }));
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /total changed to \$1000\.00/);
  net.restore(); setEnv(); net = installFetch();
  res = await run(validBody({ cardFunding: 'credit', expectedTotal: '1000.00' }));
  assert.equal(res.statusCode, 409);
  assert.equal(find(net.calls, 'authorize.net'), undefined);
});
