# HB Authorize.net Payments (backend)

Vercel serverless backend for the Hatton-Brown hosted payment form that replaces the four Wufoo forms.
Front end (WordPress/Divi + Accept.js) lives on hattonbrown.net; **all credentials live only here, in Vercel env vars.**
Raw card data never reaches this server: Accept.js tokenizes in the browser and only the payment nonce is sent.

| Entry point | `account` |
| --- | --- |
| hattonbrown.net/payhb | `hb` |
| hattonbrown.net/paypw | `pw` (build/test first) |
| hattonbrown.net/payexpo | `expo` |
| hattonbrown.net/paypwshow | `pwshow` |

## Status

| Section | State |
| --- | --- |
| 1 Account routing / allowlist | Done |
| 4 `/api/config`, `/api/charge` | Done; unit-tested with mocked Authorize.net/Turnstile/Supabase. **Not yet run against the real sandbox** (needs sandbox credentials) |
| 5 Turnstile, rate limit, honeypot | Done |
| 7 Supabase table + logging | Migration written, logging wired. **Migration not yet applied to a project** |
| 6 Emails (Resend) | Done: customer receipt + internal notification (two templates). **Needs a verified Resend sending domain and `RESEND_API_KEY` / `EMAIL_FROM`** |
| 2, 3, 9 Divi front end | Not started (after Section 4 check-in) |

## API

### `GET /api/config?account=pw`
```json
{ "apiLoginId": "...", "clientKey": "...", "environment": "sandbox", "turnstileSiteKey": "..." }
```
`environment` (sandbox/live) tells the front end which Accept.js URL to load; `turnstileSiteKey` is public.
The Transaction Key is never returned. Unknown account → 400.

### `POST /api/charge` (JSON)
```json
{
  "account": "pw",
  "firstName": "", "lastName": "", "company": "", "phone": "", "email": "",
  "accountNumber": "", "city": "", "state": "", "zip": "",
  "invoiceAmount": "1234.56", "invoiceNumber": "", "chargeDescription": "",
  "signatureName": "", "agreed": true,
  "cardType": "Visa",
  "cardFunding": "credit",
  "expectedTotal": "1271.60",
  "opaqueData": { "dataDescriptor": "COMMON.ACCEPT.INAPP.PAYMENT", "dataValue": "<nonce>" },
  "turnstileToken": "<token>",
  "hb_contact_pref": ""
}
```
* `expectedTotal` is optional: the total the customer saw. Fee/total are **always recomputed server-side** (3%, half-up to the cent, integer math); if `expectedTotal` is sent and differs, the request is refused with 409 *before* any charge.
* `hb_contact_pref` is the honeypot — keep it hidden and empty.
* `cardFunding` (`credit` or `debit`) decides whether the 3% fee applies; see below.
* `cardType` is display-only (Visa/Mastercard/Discover/Amex/Unknown); the logged value prefers what Authorize.net reports.

Responses: `200 {ok:true, transactionId, last4, cardType, invoiceAmount, convenienceFee, totalCharged, receiptEmailSent}`;
`402` declined and `502` gateway error → `{ok:false, status, error}` (plain-language `error`);
`400` validation (`{error, fields}`); `403` bad origin; `409` total mismatch; `429` rate limited; `503` log store down.

Order of checks: origin → honeypot → validation/allowlist → fee recompute → rate limit → Turnstile → Authorize.net → log → emails (approved only).

Notes on behavior:
* Emails go out through Resend's REST API after an approval: a receipt to the customer and an internal notification (default `hbcc@hattonbrown.com`, subject `[PW] Payment received — $1,030.00 — Company`; sandbox charges are additionally tagged `[SANDBOX]`). Each send uses an idempotency key built from the Authorize.net transaction ID, so a retry can't double-send. Email failures never change the payment response; the `receipt_email_sent` / `internal_email_sent` columns are updated on the logged row to show what actually went out. All customer-supplied text is HTML-escaped.
* **Debit cards carry no convenience fee.** The form looks up the card type from the first 8 digits (only those 8 digits leave the browser) using the free HandyAPI BIN service (`https://data.handyapi.com/bin/<bin>`, no key). Debit (including prepaid, which the service reports as debit) = no fee; credit = 3%. If the lookup fails, times out, or returns no type, the form asks the customer "credit or debit?" instead. The browser sends `cardFunding` (`credit`/`debit`); the server recomputes the fee from it (anything else means credit, so the fee applies) and refuses a request whose `expectedTotal` doesn't match. **Because our server never sees the card number, it cannot verify `cardFunding`**: a customer who edits the page could claim debit. The log records it (`card_type` becomes e.g. `Visa (debit)`, and `convenience_fee` is `0.00`). Free-service terms can change: if it stops working the form degrades to asking the customer, and the lookup URL is one constant (`LOOKUP_URL`) at the top of the script.
* Rate limit is 5 attempts / 10 min / IP, using an in-memory window plus a durable count of logged attempts in Supabase. If Supabase can't be read the endpoint fails closed (503): we don't take payments we can't audit.
* Attempts rejected before Authorize.net (validation, Turnstile, rate limit) are not logged; every attempt that reaches Authorize.net is (approved / declined / error).
* If the log write fails *after* a charge, the customer still gets their success and the transaction ID is written to the function logs for reconciliation.
* If Authorize.net times out, the customer is told not to resubmit; check the Authorize.net dashboard (`refId` is in the log line).
* Free-text fields containing a Luhn-valid card number are rejected so a PAN never lands in the log.
* Authorize.net caps invoice numbers at 20 chars; longer ones are truncated for Authorize.net, the full value is put in its description, and the full value is kept in Supabase.
* CORS: `https://hattonbrown.net`, `https://www.hattonbrown.net`, plus `LOCAL_DEV_ORIGIN` (default `http://localhost:8080`) outside production. `/api/charge` requires an allowed `Origin`.

## Environment variables
See `.env.example`. Per account (`HB`, `PW`, `EXPO`, `PWSHOW`): `AUTHNET_{ACCT}_LOGIN_ID|TXN_KEY|CLIENT_KEY` (live) and
`AUTHNET_SANDBOX_{ACCT}_LOGIN_ID|TXN_KEY|CLIENT_KEY` (sandbox). **In sandbox mode only**, an account with no sandbox credentials of its own uses Panel World's (`AUTHNET_SANDBOX_PW_*`), so one sandbox account can serve all four pages while testing. Live mode never falls back. `AUTHNET_SANDBOX_MODE=true` selects sandbox endpoints + credentials.
Also `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, and for email `RESEND_API_KEY`, `EMAIL_FROM` (optional: `INTERNAL_NOTIFY_EMAIL`, `SANDBOX_NOTIFY_EMAIL`, `EMAIL_REPLY_TO`, `EMAIL_TIMEZONE`).

## Database
Apply `supabase/migrations/20261021000000_payment_transactions.sql`. RLS is enabled with no policies; only the service role (Vercel function) can read/write.

## Develop / test
```
npm test        # no dependencies to install
vercel dev      # local API with a .env copied from .env.example
```
