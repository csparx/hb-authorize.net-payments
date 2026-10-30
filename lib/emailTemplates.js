// Email content for successful payments. Two templates: customer receipt and internal notification.
// Every user-supplied value is HTML-escaped; subjects have line breaks stripped.

export const BRAND = 'Hatton-Brown Publishers';

// Label staff use for each account (Expo is "HBE" = Hatton Brown Expositions).
const ACCOUNT_LABELS = { hb: 'HB', pw: 'PW', expo: 'HBE', pwshow: 'PWSHOW' };
export const accountLabel = (code) => ACCOUNT_LABELS[code] || String(code).toUpperCase();

export function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const oneLine = (s) => String(s ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

/** "1030.00" -> "$1,030.00" */
export function usd(amountString) {
  const [d, c = '00'] = String(amountString).split('.');
  return `$${d.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${c}`;
}

export function formatDate(date, timeZone = 'America/Chicago') {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short',
  }).format(date);
}

function table(rows) {
  const tr = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(
      ([k, v, bold]) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#555;vertical-align:top;white-space:nowrap">${esc(k)}</td>` +
        `<td style="padding:6px 0;${bold ? 'font-weight:bold;' : ''}">${esc(v)}</td></tr>`,
    )
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:15px">${tr}</table>`;
}

function textRows(rows) {
  return rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

function shell(title, intro, rowsHtml) {
  return (
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#222">` +
    `<div style="max-width:560px;margin:0 auto;background:#fff;padding:24px;border-radius:6px">` +
    `<h2 style="margin:0 0 12px;font-size:20px">${esc(title)}</h2>` +
    `<p style="margin:0 0 16px;font-size:15px">${esc(intro)}</p>${rowsHtml}</div></body></html>`
  );
}

function paymentRows(d) {
  const { values: v, amounts: a } = d;
  return [
    ['Company', v.company],
    ['Invoice number', v.invoiceNumber],
    ['Description', v.chargeDescription],
    ['Invoice amount', usd(a.invoiceAmount)],
    d.cardFunding === 'debit'
      ? ['Surcharge', `${usd(a.convenienceFee)} (no surcharge on debit cards)`]
      : ['Surcharge (3%)', usd(a.convenienceFee)],
    ['Total charged', usd(a.totalCharged), true],
    ['Card', `${d.cardType || 'Card'}${d.cardFunding === 'debit' ? ' debit' : ''} ending in ${d.last4 || '----'}`],
    ['Date', formatDate(d.date, d.timeZone)],
    ['Transaction ID', d.transactionId],
  ];
}

export function buildReceipt(d) {
  const rows = paymentRows(d);
  const intro = `Thank you, ${d.values.firstName}. Your payment was received. Please keep this email as your receipt.`;
  const footer = `<p style="margin:20px 0 0;font-size:13px;color:#777">Questions about this payment? Reply to this email or contact ${esc(BRAND)}.</p>`;
  return {
    subject: oneLine(`Payment receipt — ${usd(d.amounts.totalCharged)} — ${BRAND}`),
    html: shell('Payment receipt', intro, table(rows) + footer),
    text: `Payment receipt\n\n${intro}\n\n${textRows(rows)}\n\nQuestions about this payment? Reply to this email or contact ${BRAND}.`,
  };
}

export function buildInternal(d) {
  const { values: v } = d;
  const rows = [
    ['Account', accountLabel(d.account)],
    ['Environment', d.environment],
    ...paymentRows(d),
    ['Account number', v.accountNumber],
    ['Contact', `${v.firstName} ${v.lastName}`],
    ['Email', v.email],
    ['Phone', v.phone],
    ['City', v.city],
    ['State', v.state],
    ['Zip', v.zip],
    ['Electronic signature', v.signatureName],
  ];
  const tag = d.environment === 'sandbox' ? '[SANDBOX] ' : '';
  const intro = `A payment was received on the ${accountLabel(d.account)} account.`;
  return {
    subject: oneLine(`${tag}[${accountLabel(d.account)}] Payment received — ${usd(d.amounts.totalCharged)} — ${v.company}`),
    html: shell('Payment received', intro, table(rows)),
    text: `Payment received\n\n${intro}\n\n${textRows(rows)}`,
  };
}
