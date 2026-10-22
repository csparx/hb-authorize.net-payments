// POST /api/charge  -> validates, recalculates the total, verifies bot protection,
// charges via Authorize.net, logs the attempt, and on approval sends the receipt + internal emails.

import { randomUUID } from 'node:crypto';
import { getAccount } from '../lib/accounts.js';
import { chargeCard } from '../lib/authnet.js';
import { sendPaymentEmails } from '../lib/email.js';
import { applyCors, clientIp, parseBody, sendJson } from '../lib/http.js';
import { computeAmounts } from '../lib/money.js';
import { checkRateLimit } from '../lib/ratelimit.js';
import { insertTransaction, updateTransaction } from '../lib/supabase.js';
import { verifyTurnstile } from '../lib/turnstile.js';
import { validateCharge } from '../lib/validate.js';

const HONEYPOT_FIELD = 'hb_contact_pref'; // must be named identically in the front end; humans never fill it
const GENERIC_REJECT = 'We could not process this request.';

export default async function handler(req, res) {
  const cors = applyCors(req, res, 'POST');

  if (req.method === 'OPTIONS') {
    res.status(cors.allowed ? 204 : 403).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  // Real browsers always send Origin on a cross-origin POST.
  if (!cors.allowed) return sendJson(res, 403, { error: 'Origin not allowed.' });

  const body = parseBody(req);
  if (!body) return sendJson(res, 400, { error: 'Invalid request.' });

  if (typeof body[HONEYPOT_FIELD] === 'string' && body[HONEYPOT_FIELD].trim() !== '') {
    return sendJson(res, 400, { error: GENERIC_REJECT });
  }

  // 1. Validate account (allowlist) and all required fields.
  const v = validateCharge(body);
  if (!v.ok) {
    return sendJson(res, 400, { error: Object.values(v.errors)[0], fields: v.errors });
  }
  const values = v.values;

  const account = getAccount(values.account);
  if (!account) {
    console.error(`charge: account "${values.account}" is not fully configured`);
    return sendJson(res, 500, { error: 'This payment account is not available right now.' });
  }

  // 2. Recalculate fee + total server-side. Browser-sent totals are never used for the charge.
  const amounts = computeAmounts(values.invoiceCents);
  if (values.expectedTotal != null && values.expectedTotal !== amounts.totalCharged) {
    return sendJson(res, 409, {
      error: `The total changed to $${amounts.totalCharged}. Please review it and submit again.`,
    });
  }

  // 3. Bot protection: rate limit, then Turnstile.
  const ip = clientIp(req);
  try {
    const rl = await checkRateLimit(ip);
    if (rl.limited) {
      res.setHeader('Retry-After', '600');
      return sendJson(res, 429, {
        error: 'Too many payment attempts. Please wait 10 minutes and try again, or contact Hatton-Brown.',
      });
    }
  } catch (err) {
    console.error('charge: rate-limit store unavailable:', err.message);
    return sendJson(res, 503, { error: 'Payments are temporarily unavailable. Please try again shortly.' });
  }

  const ts = await verifyTurnstile(values.turnstileToken, ip);
  if (!ts.ok) {
    console.warn(`charge: turnstile rejected (${ts.reason})`);
    return sendJson(res, 400, { error: 'Security check failed. Please refresh the page and try again.' });
  }

  // 4. Authorize.net authCaptureTransaction with the server-calculated total.
  const refId = randomUUID().replace(/-/g, '').slice(0, 20);
  const result = await chargeCard({
    account,
    amount: amounts.totalCharged,
    opaqueData: values.opaqueData,
    values,
    ip,
    refId,
  });

  // 5. Log success or failure. Never store card number, expiry, CVV, or the nonce.
  const row = {
    account: account.code,
    environment: account.environment,
    status: result.status,
    authnet_transaction_id: result.transactionId,
    authnet_response_code: result.responseCode,
    authnet_message: result.authnetMessage,
    invoice_amount: amounts.invoiceAmount,
    convenience_fee: amounts.convenienceFee,
    total_charged: amounts.totalCharged,
    invoice_number: values.invoiceNumber || null,
    account_number: values.accountNumber || null,
    charge_description: values.chargeDescription,
    first_name: values.firstName,
    last_name: values.lastName,
    company: values.company,
    email: values.email,
    phone: values.phone,
    city: values.city || null,
    state: values.state || null,
    zip: values.zip || null,
    signature_name: values.signatureName,
    card_type: result.cardType || values.cardType,
    card_last4: result.last4,
    receipt_email_sent: false,
    internal_email_sent: false,
    ip_address: ip,
  };
  let rowId = null;
  try {
    rowId = await insertTransaction(row);
  } catch (err) {
    // The charge already happened; don't turn a logged-elsewhere success into a failure.
    console.error(
      `charge: LOG WRITE FAILED account=${account.code} status=${result.status} txn=${result.transactionId} refId=${refId}: ${err.message}`,
    );
  }

  // 6. On success, send the customer receipt + internal notification. Never affects the response.
  let emails = { receipt: false, internal: false };
  if (result.status === 'approved') {
    emails = await sendPaymentEmails({
      account: account.code,
      environment: account.environment,
      values,
      amounts,
      transactionId: result.transactionId,
      last4: result.last4,
      cardType: result.cardType || values.cardType,
    });
    if (rowId && (emails.receipt || emails.internal)) {
      try {
        await updateTransaction(rowId, { receipt_email_sent: emails.receipt, internal_email_sent: emails.internal });
      } catch (err) {
        console.error(`charge: email flag update failed txn=${result.transactionId}: ${err.message}`);
      }
    }
  }

  if (result.status === 'approved') {
    return sendJson(res, 200, {
      ok: true,
      transactionId: result.transactionId,
      last4: result.last4,
      cardType: result.cardType || values.cardType,
      invoiceAmount: amounts.invoiceAmount,
      convenienceFee: amounts.convenienceFee,
      totalCharged: amounts.totalCharged,
      receiptEmailSent: emails.receipt,
    });
  }
  return sendJson(res, result.status === 'declined' ? 402 : 502, { ok: false, status: result.status, error: result.userMessage });
}
