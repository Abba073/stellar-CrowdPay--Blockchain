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

test('more than seven fractional digits is rejected instead of silently truncated', () => {
  const tooPrecise = ['1.99999999', '0.12345678', '10.00000001'];
  for (const bad of tooPrecise) {
    assert.throws(
      () => parseAmountToStroops(bad, 'amount'),
      (err) => {
        assert.ok(err instanceof InvalidAmountError, `expected InvalidAmountError for ${bad}`);
        assert.equal(err.status, 422);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.equal(err.field, 'amount');
        return true;
      }
    );
    assert.throws(() => parseUserAmount(bad, 'amount'), (err) => err instanceof InvalidAmountError && err.status === 422);
    assert.equal(tryParseAmountToStroops(bad), null);
  }
});

test('seven fractional digits is accepted at the precision boundary', () => {
  assert.equal(parseAmountToStroops('1.9999999'), 19999999n);
  assert.equal(parseUserAmount('1.9999999', 'amount'), 19999999n);
  assert.equal(tryParseAmountToStroops('1.9999999'), 19999999n);
});

test('amounts exceeding the NUMERIC(20,7) maximum are rejected', () => {
  const tooLarge = ['99999999999999', '1000000000000', '9999999999999.9999999'];
  for (const bad of tooLarge) {
    assert.throws(
      () => parseAmountToStroops(bad, 'target_amount'),
      (err) => {
        assert.ok(err instanceof InvalidAmountError, `expected InvalidAmountError for ${bad}`);
        assert.equal(err.status, 422);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.equal(err.field, 'target_amount');
        return true;
      }
    );
    assert.throws(() => parseUserAmount(bad, 'target_amount'), (err) => err instanceof InvalidAmountError && err.status === 422);
    assert.equal(tryParseAmountToStroops(bad), null);
  }
});

test('the NUMERIC(20,7) maximum itself is accepted', () => {
  assert.equal(parseAmountToStroops('9999999999999.9999999'), 99999999999999999999n);
  assert.equal(parseUserAmount('9999999999999.9999999', 'amount'), 99999999999999999999n);
  assert.equal(tryParseAmountToStroops('9999999999999.9999999'), 99999999999999999999n);
});
