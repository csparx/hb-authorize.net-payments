import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAmounts, parseAmountToCents } from '../lib/money.js';

test('3% fee, rounded half-up to the cent', () => {
  const cases = [
    ['1000.00', '30.00', '1030.00'],
    ['1234.56', '37.04', '1271.60'],
    ['0.50', '0.02', '0.52'], // 0.015 -> 0.02
    ['33.33', '1.00', '34.33'], // 0.9999 -> 1.00
    ['0.01', '0.00', '0.01'],
    ['999999.99', '30000.00', '1029999.99'],
  ];
  for (const [inv, fee, total] of cases) {
    const a = computeAmounts(parseAmountToCents(inv));
    assert.equal(a.convenienceFee, fee, `fee for ${inv}`);
    assert.equal(a.totalCharged, total, `total for ${inv}`);
  }
});

test('amount parsing is strict', () => {
  assert.equal(parseAmountToCents('$1,234.5'), 123450);
  assert.equal(parseAmountToCents(12), 1200);
  for (const bad of ['', '0', '0.00', '-5', '1.234', 'abc', '1e3', '1000000', null, undefined, {}, [], '12.']) {
    assert.equal(parseAmountToCents(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('debit cards carry no surcharge; credit/unknown still pay 3%', () => {
  const c = parseAmountToCents('1234.56');
  assert.deepEqual(
    [computeAmounts(c, 'debit').convenienceFee, computeAmounts(c, 'debit').totalCharged],
    ['0.00', '1234.56'],
  );
  assert.equal(computeAmounts(c, 'credit').totalCharged, '1271.60');
  assert.equal(computeAmounts(c).totalCharged, '1271.60');
  assert.equal(computeAmounts(c, 'prepaid-or-garbage').totalCharged, '1271.60');
});
