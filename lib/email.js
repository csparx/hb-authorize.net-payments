// Post-charge emails via Resend's REST API (no SDK). Never throws: email problems must not
// affect a payment that already went through.

import { buildInternal, buildReceipt } from './emailTemplates.js';

const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_INTERNAL = 'hbcc@hattonbrown.com';

export function emailConfig(env = process.env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM;
  if (!apiKey || !from) return null;
  const list = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
  const sandbox = String(env.AUTHNET_SANDBOX_MODE).toLowerCase() === 'true';
  // In sandbox, optionally keep test notifications out of the real inbox.
  const internalTo = list(sandbox && env.SANDBOX_NOTIFY_EMAIL ? env.SANDBOX_NOTIFY_EMAIL : env.INTERNAL_NOTIFY_EMAIL || DEFAULT_INTERNAL);
  return { apiKey, from, internalTo, replyTo: env.EMAIL_REPLY_TO || undefined, timeZone: env.EMAIL_TIMEZONE || 'America/Chicago' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(cfg, msg, fetchImpl) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': msg.idempotencyKey, // a retry can never double-send
      },
      body: JSON.stringify({
        from: cfg.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) return;
    // Resend's default limit is 2 requests/second; retry once on 429 / 5xx.
    if (attempt === 0 && (resp.status === 429 || resp.status >= 500)) {
      await sleep(600);
      continue;
    }
    throw new Error(`Resend HTTP ${resp.status}`);
  }
}

/**
 * Sends the customer receipt and the internal notification for an approved payment.
 * data: { account, environment, values, amounts, transactionId, last4, cardType }
 * Returns { receipt: boolean, internal: boolean }.
 */
export async function sendPaymentEmails(data, { env = process.env, fetchImpl = fetch, now = new Date() } = {}) {
  const out = { receipt: false, internal: false };
  const cfg = emailConfig(env);
  if (!cfg) {
    console.error('email: RESEND_API_KEY / EMAIL_FROM not configured; no emails sent');
    return out;
  }
  const d = { ...data, date: now, timeZone: cfg.timeZone };
  const key = data.transactionId || `${data.account}-${now.getTime()}`;

  try {
    await send(cfg, { ...buildReceipt(d), to: [data.values.email], replyTo: cfg.replyTo, idempotencyKey: `receipt-${key}` }, fetchImpl);
    out.receipt = true;
  } catch (err) {
    console.error(`email: receipt failed txn=${data.transactionId}: ${err.message}`);
  }
  try {
    await send(cfg, { ...buildInternal(d), to: cfg.internalTo, replyTo: data.values.email, idempotencyKey: `internal-${key}` }, fetchImpl);
    out.internal = true;
  } catch (err) {
    console.error(`email: internal notification failed txn=${data.transactionId}: ${err.message}`);
  }
  return out;
}
