// All money math is done in integer cents to avoid float drift.

export const FEE_RATE_PERCENT = 3;
export const MAX_CENTS = 99999999; // $999,999.99

/** Parses "1234.56" (also tolerates "$1,234.56") into integer cents, or null if invalid. */
export function parseAmountToCents(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const s = String(input).replace(/[\s$,]/g, '');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  const [dollars, frac = ''] = s.split('.');
  const cents = Number(dollars) * 100 + Number(frac.padEnd(2, '0'));
  if (cents < 1 || cents > MAX_CENTS) return null;
  return cents;
}

/** 3% of the invoice, rounded half-up to the cent. */
export function feeCents(invoiceCents) {
  return Math.floor((invoiceCents * FEE_RATE_PERCENT + 50) / 100);
}

export function centsToString(cents) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * Server-authoritative amounts, in cents and as "0.00" strings.
 * Debit cards carry no surcharge (cardFunding === 'debit'); anything else pays the 3%.
 */
export function computeAmounts(invoiceCents, cardFunding = 'credit') {
  const fee = cardFunding === 'debit' ? 0 : feeCents(invoiceCents);
  const total = invoiceCents + fee;
  return {
    invoiceCents,
    feeCents: fee,
    totalCents: total,
    invoiceAmount: centsToString(invoiceCents),
    convenienceFee: centsToString(fee),
    totalCharged: centsToString(total),
  };
}
