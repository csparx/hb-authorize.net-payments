import { isAllowedAccount } from './accounts.js';
import { parseAmountToCents } from './money.js';

export const CARD_TYPES = ['Visa', 'Mastercard', 'Discover', 'Amex', 'Unknown'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// field -> [required, maxLength]
const TEXT_FIELDS = {
  firstName: [true, 50],
  lastName: [true, 50],
  company: [true, 100],
  phone: [true, 40],
  email: [true, 100],
  chargeDescription: [true, 255],
  signatureName: [true, 100],
  accountNumber: [false, 50],
  invoiceNumber: [false, 50],
  city: [false, 60],
  state: [false, 40],
  zip: [false, 20],
};

const LABELS = {
  firstName: 'First name',
  lastName: 'Last name',
  company: 'Company',
  phone: 'Phone',
  email: 'Email',
  chargeDescription: 'Charge description',
  signatureName: 'Electronic signature',
  accountNumber: 'Account number',
  invoiceNumber: 'Invoice number',
  city: 'City',
  state: 'State',
  zip: 'Zip',
};

// People paste card numbers into free-text boxes. We never want one in the log.
const FREE_TEXT_FIELDS = ['firstName', 'lastName', 'company', 'chargeDescription', 'signatureName', 'city', 'state'];

export function luhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function looksLikeCardNumber(text) {
  const matches = String(text).match(/\d(?:[ -]?\d){12,18}/g) || [];
  return matches.some((m) => luhnValid(m.replace(/\D/g, '')));
}

/**
 * Validates and normalizes the /api/charge body.
 * Returns { ok: true, values } or { ok: false, errors: { field: message } }.
 * Never trusts any total from the browser; amounts are recomputed by the caller.
 */
export function validateCharge(body) {
  const errors = {};
  const values = {};

  if (!isAllowedAccount(body.account)) {
    errors.account = 'Invalid account.';
  } else {
    values.account = body.account;
  }

  for (const [field, [required, max]] of Object.entries(TEXT_FIELDS)) {
    const raw = body[field];
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (raw != null && typeof raw !== 'string') {
      errors[field] = `${LABELS[field]} is invalid.`;
    } else if (required && !v) {
      errors[field] = `${LABELS[field]} is required.`;
    } else if (v.length > max) {
      errors[field] = `${LABELS[field]} must be ${max} characters or fewer.`;
    } else {
      values[field] = v;
    }
  }

  if (values.email && !EMAIL_RE.test(values.email)) errors.email = 'Enter a valid email address.';

  for (const f of FREE_TEXT_FIELDS) {
    if (values[f] && looksLikeCardNumber(values[f])) {
      errors[f] = `${LABELS[f]} must not contain a card number. Enter card details only in the secure card fields.`;
    }
  }

  const invoiceCents = parseAmountToCents(body.invoiceAmount);
  if (invoiceCents == null) {
    errors.invoiceAmount = 'Enter a valid invoice amount, e.g. 1234.56 (max 999,999.99).';
  } else {
    values.invoiceCents = invoiceCents;
  }

  if (body.agreed !== true) {
    errors.agreed = 'You must agree to be charged the total shown.';
  }

  // Display-only hint from the browser; used for logging if Authorize.net doesn't return one.
  values.cardType = CARD_TYPES.includes(body.cardType) ? body.cardType : 'Unknown';

  const od = body.opaqueData;
  if (
    !od ||
    typeof od.dataDescriptor !== 'string' ||
    typeof od.dataValue !== 'string' ||
    !od.dataValue ||
    od.dataValue.length > 2048
  ) {
    errors.opaqueData = 'Payment token is missing. Please re-enter your card details.';
  } else {
    values.opaqueData = { dataDescriptor: od.dataDescriptor, dataValue: od.dataValue };
  }

  if (typeof body.turnstileToken !== 'string' || !body.turnstileToken || body.turnstileToken.length > 4096) {
    errors.turnstileToken = 'Please complete the security check.';
  } else {
    values.turnstileToken = body.turnstileToken;
  }

  // Optional safety check: the total the customer saw and agreed to.
  if (body.expectedTotal != null) values.expectedTotal = String(body.expectedTotal);

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}
