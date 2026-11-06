// Authorize.net createTransactionRequest (authCaptureTransaction) using an Accept.js nonce.
// The raw card number never reaches this server: only the opaque payment nonce does.

export const ENDPOINTS = {
  sandbox: 'https://apitest.authorize.net/xml/v1/request.api',
  live: 'https://api.authorize.net/xml/v1/request.api',
};

const TIMEOUT_MS = 25000;

// Credential/config problems: don't show Authorize.net's wording to a customer.
const CONFIG_ERROR_CODES = new Set(['E00003', 'E00005', 'E00006', 'E00007', 'E00008', 'E00009', 'E00010', 'E00011']);
const GENERIC_CONFIG_MESSAGE = 'The payment system is temporarily unavailable. Please contact Hatton-Brown so we can take your payment another way.';
const GENERIC_ERROR_MESSAGE = 'We could not process your payment. Please try again or contact Hatton-Brown.';
const EXPIRED_NONCE_MESSAGE = 'Your card entry expired. Please re-enter your card details and try again.';

const trunc = (s, n) => (s ? String(s).slice(0, n) : undefined);

function normalizeCardType(t) {
  if (!t) return null;
  const s = String(t).toLowerCase();
  if (s.includes('visa')) return 'Visa';
  if (s.includes('master')) return 'Mastercard';
  if (s.includes('discover')) return 'Discover';
  if (s.includes('american') || s.includes('amex')) return 'Amex';
  return String(t);
}

export function buildRequest({ account, amount, opaqueData, values, ip, refId }) {
  const invoice = values.invoiceNumber || '';
  // Authorize.net caps invoiceNumber at 20 chars; keep the full value visible in the description.
  let description = values.chargeDescription;
  if (invoice.length > 20) description = `Inv ${invoice} - ${description}`;

  const transactionRequest = {
    transactionType: 'authCaptureTransaction',
    amount,
    payment: { opaqueData },
    order: {
      ...(invoice ? { invoiceNumber: invoice.slice(0, 20) } : {}),
      description: trunc(description, 255),
    },
    customer: { email: trunc(values.email, 255) },
    billTo: {
      firstName: trunc(values.firstName, 50),
      lastName: trunc(values.lastName, 50),
      company: trunc(values.company, 50),
      city: trunc(values.city, 40),
      state: trunc(values.state, 40),
      zip: trunc(values.zip, 20),
      phoneNumber: trunc(values.phone, 25),
    },
  };
  if (ip && ip !== 'unknown' && /^[0-9a-fA-F:.]+$/.test(ip)) transactionRequest.customerIP = ip;

  return {
    createTransactionRequest: {
      merchantAuthentication: { name: account.loginId, transactionKey: account.transactionKey },
      refId,
      transactionRequest,
    },
  };
}

/**
 * Normalizes an Authorize.net JSON response.
 * status: approved | declined | error. userMessage is safe to show the customer.
 */
export function parseResponse(json) {
  const t = json?.transactionResponse;
  const top = json?.messages?.message?.[0];
  const topOk = json?.messages?.resultCode === 'Ok';
  const detail = t?.errors?.[0] || t?.messages?.[0];
  const detailCode = detail?.errorCode || detail?.code || top?.code || '';
  const detailText = detail?.errorText || detail?.description || top?.text || '';
  const responseCode = t?.responseCode || top?.code || '';
  const authnetMessage = [detailCode, detailText].filter(Boolean).join(': ') || 'No message returned';

  const base = {
    transactionId: t?.transId && t.transId !== '0' ? String(t.transId) : null,
    responseCode: String(responseCode),
    authnetMessage,
    last4: /(\d{4})$/.exec(t?.accountNumber || '')?.[1] || null,
    cardType: normalizeCardType(t?.accountType),
  };

  if (t && t.responseCode === '1' && topOk) return { ...base, status: 'approved', userMessage: 'Approved' };

  if (t && t.responseCode === '2') {
    return { ...base, status: 'declined', userMessage: detailText || 'Your card was declined.' };
  }

  if (t && t.responseCode === '4') {
    return {
      ...base,
      status: 'error',
      userMessage: 'Your payment is being held for review. Please contact Hatton-Brown before trying again.',
    };
  }

  let userMessage = detailText || GENERIC_ERROR_MESSAGE;
  if (CONFIG_ERROR_CODES.has(detailCode)) userMessage = GENERIC_CONFIG_MESSAGE;
  else if (detailCode === 'E00114' || /invalid ots token/i.test(detailText)) userMessage = EXPIRED_NONCE_MESSAGE;
  return { ...base, status: 'error', userMessage };
}

export async function chargeCard({ account, amount, opaqueData, values, ip, refId, fetchImpl = fetch }) {
  const body = buildRequest({ account, amount, opaqueData, values, ip, refId });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetchImpl(ENDPOINTS[account.environment], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = (await resp.text()).replace(/^﻿/, ''); // Authorize.net prefixes a BOM
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return unknownOutcome(`HTTP ${resp.status}, unparseable response`);
    }
    return parseResponse(json);
  } catch (err) {
    return unknownOutcome(err?.name === 'AbortError' ? 'Timed out waiting for Authorize.net' : 'Network error reaching Authorize.net');
  } finally {
    clearTimeout(timer);
  }
}

// We can't know whether the card was charged; tell the customer not to retry blindly.
function unknownOutcome(detail) {
  return {
    status: 'error',
    transactionId: null,
    responseCode: '',
    authnetMessage: detail,
    last4: null,
    cardType: null,
    userMessage:
      'We could not confirm whether your payment went through. Please do not submit again; contact Hatton-Brown to confirm before retrying.',
  };
}
