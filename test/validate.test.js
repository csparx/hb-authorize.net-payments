import test from 'node:test';
import assert from 'node:assert/strict';
import { luhnValid, looksLikeCardNumber, validateCharge } from '../lib/validate.js';
import { validBody } from './helpers.js';

test('valid body passes and normalizes', () => {
  const r = validateCharge(validBody({ firstName: '  Ada ' }));
  assert.equal(r.ok, true);
  assert.equal(r.values.firstName, 'Ada');
  assert.equal(r.values.invoiceCents, 100000);
});

test('required fields, allowlist, agreement', () => {
  for (const f of ['firstName', 'lastName', 'company', 'phone', 'email', 'chargeDescription', 'signatureName', 'invoiceAmount', 'turnstileToken', 'opaqueData']) {
    const r = validateCharge(validBody({ [f]: undefined }));
    assert.equal(r.ok, false, f);
    assert.ok(r.errors[f], f);
  }
  assert.ok(validateCharge(validBody({ account: 'other' })).errors.account);
  assert.ok(validateCharge(validBody({ account: '__proto__' })).errors.account);
  assert.ok(validateCharge(validBody({ agreed: 'true' })).errors.agreed);
  assert.ok(validateCharge(validBody({ email: 'nope' })).errors.email);
});

test('optional fields may be blank; phone has no pattern', () => {
  const r = validateCharge(validBody({ city: '', state: '', zip: '', accountNumber: '', invoiceNumber: '', phone: 'ext 5 / call mornings' }));
  assert.equal(r.ok, true);
});

test('card numbers typed into free text are rejected', () => {
  assert.equal(luhnValid('4111111111111111'), true);
  assert.equal(looksLikeCardNumber('pay with 4111 1111 1111 1111 thanks'), true);
  assert.equal(looksLikeCardNumber('Invoice 2024-0012'), false);
  const r = validateCharge(validBody({ chargeDescription: 'card 4111-1111-1111-1111' }));
  assert.ok(r.errors.chargeDescription);
});

test('unknown card type falls back to Unknown', () => {
  assert.equal(validateCharge(validBody({ cardType: 'Diners' })).values.cardType, 'Unknown');
});
