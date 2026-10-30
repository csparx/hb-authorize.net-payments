# Divi page blocks

Each payment page uses two **Code** modules (not Text modules), pasted in this order:

1. The header banner for that account
2. The payment form for that account (the account is already set in the file)

| Page | Header banner | Form |
| --- | --- | --- |
| Panel World (`/paypw`) | `payment-header.html` | `payment-form-pw.html` |
| HB (`/payhb`) | `payment-header-hb.html` | `payment-form-hb.html` |
| Expo / HBE (`/payexpo`) | `payment-header-expo.html` | `payment-form-expo.html` |
| PW Show (`/paypwshow`) | `payment-header-pwshow.html` | `payment-form-pwshow.html` |

`payment-form.html` is the master copy with no account set. The `payment-form-<account>.html` files are copies of it with
`data-account="<account>"` added to the first `<div id="hb-pay">` line. If the master changes, regenerate the four copies.

Each file is one block with no blank lines, so WordPress doesn't add stray paragraph tags. Don't add blank lines.
