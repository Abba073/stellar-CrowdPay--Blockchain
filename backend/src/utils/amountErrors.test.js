// Pure tests for amount parsing errors. Kept separate from amounts.test.js,
// which imports stellarService and needs its full runtime environment.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InvalidAmountError,
  parseAmountToStroops,
  tryParseAmountToStroops,
  parseUserAmount,
} = require('./amounts');

const MALFORMED = ['abc', '', '  ', '1e5', '1E-7', '-1', '1.2.3', '0x10', 'NaN', 'Infinity', null, undefined, {}, [], NaN];

test('malformed input throws InvalidAmountError mapped to 422 VALIDATION_ERROR with a field message', () => {
  for (const bad of MALFORMED) {
    assert.throws(
      () => parseAmountToStroops(bad, 'min_contribution'),
      (err) => {
        assert.ok(err instanceof InvalidAmountError, `expected InvalidAmountError for ${JSON.stringify(bad)}`);
        assert.equal(err.status, 422);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.equal(err.field, 'min_contribution');
        assert.match(err.fields.min_contribution, /min_contribution/);
        return true;
      }
    );
  }
});

test('error messages do not echo the raw input', () => {
  assert.throws(
    () => parseAmountToStroops('<script>alert(1)</script>'),
    (err) => !err.message.includes('<script>')
  );
});

test('tryParseAmountToStroops returns null instead of throwing', () => {
  for (const bad of MALFORMED) assert.equal(tryParseAmountToStroops(bad), null);
  assert.equal(tryParseAmountToStroops('10.5'), 105000000n);
  assert.equal(tryParseAmountToStroops(' 0.0000001 '), 1n);
});

test('parseUserAmount requires a positive amount by default', () => {
  assert.equal(parseUserAmount('2', 'amount'), 20000000n);
  assert.throws(() => parseUserAmount('0', 'amount'), (err) => err instanceof InvalidAmountError && /greater than zero/.test(err.message));
  assert.equal(parseUserAmount('0', 'amount', { allowZero: true }), 0n);
  assert.throws(() => parseUserAmount('1e5', 'dest_amount'), (err) => err.field === 'dest_amount');
});

test('validators and the parser agree: isFloat-style inputs that used to slip through are rejected', () => {
  // These passed express-validator's isFloat({ gt: 0 }) but made the parser throw (500).
  for (const slipped of ['1e5', '1.5E2', '1.12345678'.replace(/8$/, 'e1')]) {
    assert.equal(tryParseAmountToStroops(slipped), null);
  }
});
