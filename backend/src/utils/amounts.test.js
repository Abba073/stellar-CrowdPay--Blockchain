const test = require('node:test');
const assert = require('node:assert/strict');

// Env required by src/services/stellarService's module-level setup.
process.env.PLATFORM_SECRET_KEY = process.env.PLATFORM_SECRET_KEY || 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR';
process.env.USDC_ISSUER = process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet';
process.env.STELLAR_HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';

const {
  STROOPS_PER_UNIT,
  parseAmountToStroops,
  formatStroops,
  normalizeAmount,
  calculateFeeStroops,
  getPlatformFeeBps,
} = require('./amounts');

const { calcFee } = require('../services/stellarService');

test('parseAmountToStroops converts decimal strings exactly', () => {
  assert.equal(parseAmountToStroops('0'), 0n);
  assert.equal(parseAmountToStroops('0.5'), STROOPS_PER_UNIT / 2n);
  assert.equal(parseAmountToStroops('1'), STROOPS_PER_UNIT);
  assert.equal(parseAmountToStroops('0.0000001'), 1n);
  assert.equal(parseAmountToStroops('10.0000000'), 10n * STROOPS_PER_UNIT);
  assert.equal(parseAmountToStroops('1234567890123.1234567'), 12345678901231234567n);
  assert.equal(parseAmountToStroops('+0.0000001'), 1n);
  assert.equal(parseAmountToStroops(' 1.5 '), 15000000n);
});

test('parseAmountToStroops trims excess decimals toward zero (never floats)', () => {
  // A value like this previously rounded/errored via toFixed(7); deterministic
  // truncation matches NUMERIC(20,7) storage and on-chain 7-decimal limits.
  assert.equal(parseAmountToStroops('1.00000005'), STROOPS_PER_UNIT);
  assert.equal(parseAmountToStroops('1.99999999'), 19999999n);
});

test('parseAmountToStroops rejects non-decimal and scientific input', () => {
  for (const bad of ['abc', '', '1e-7', '1E3', '1.2.3', '1,5', '-0.5', NaN, Infinity]) {
    assert.throws(() => parseAmountToStroops(bad), Error, `expected ${bad} to be rejected`);
  }
});

test('formatStroops renders trimmed decimal strings', () => {
  assert.equal(formatStroops(0n), '0');
  assert.equal(formatStroops(1n), '0.0000001');
  assert.equal(formatStroops(15000000n), '1.5');
  assert.equal(formatStroops(STROOPS_PER_UNIT), '1');
  assert.equal(formatStroops(500000000n), '50');
  assert.equal(formatStroops(12345678901231234567n), '1234567890123.1234567');
});

test('formatStroops and parseAmountToStroops round-trip', () => {
  for (const value of ['0', '0.0000001', '0.5', '10', '1234567890123.1234567']) {
    assert.equal(formatStroops(parseAmountToStroops(value)), value);
  }
});

test('calculateFeeStroops keeps fee + net === amount (no drift)', () => {
  const bps = 500; // 5%
  for (const amount of ['0.0000001', '0.0000001' /* fee floors to 0 */, '0.75', '10.0000001', '1234567890123.1234567']) {
    const amountStroops = parseAmountToStroops(amount);
    const { feeStroops, netStroops } = calculateFeeStroops(amountStroops, bps);
    assert.equal(feeStroops + netStroops, amountStroops);
    assert.equal(feeStroops >= 0n, true);
    assert.equal(netStroops >= 0n, true);
  }
});

test('calculateFeeStroops floors the fee toward the campaign', () => {
  // 5% of 3 stroops = 0.15 stroops -> floors to 0, campaign keeps everything.
  const { feeStroops, netStroops } = calculateFeeStroops(3n, 500);
  assert.equal(feeStroops, 0n);
  assert.equal(netStroops, 3n);
  // 5% of 21 stroops = 1.05 stroops -> 1 stroop fee, 20 net (exact split).
  const split = calculateFeeStroops(21n, 500);
  assert.equal(split.feeStroops, 1n);
  assert.equal(split.netStroops, 20n);
});

test('calculateFeeStroops validates the bps rate', () => {
  assert.throws(() => calculateFeeStroops(100n, '500'), /Invalid fee rate/);
  assert.throws(() => calculateFeeStroops(100n, 10001), /Invalid fee rate/);
  assert.throws(() => calculateFeeStroops(100n, -1), /Invalid fee rate/);
  assert.throws(() => calculateFeeStroops(100n, 500.5), /Invalid fee rate/);
});

test('getPlatformFeeBps reads and validates PLATFORM_FEE_BPS', () => {
  const previous = process.env.PLATFORM_FEE_BPS;
  try {
    process.env.PLATFORM_FEE_BPS = '250';
    assert.equal(getPlatformFeeBps(), 250);
    process.env.PLATFORM_FEE_BPS = '';
    assert.equal(getPlatformFeeBps(), 0);
    process.env.PLATFORM_FEE_BPS = 'not-a-number';
    assert.throws(() => getPlatformFeeBps(), /Invalid PLATFORM_FEE_BPS/);
    process.env.PLATFORM_FEE_BPS = '10001';
    assert.throws(() => getPlatformFeeBps(), /Invalid PLATFORM_FEE_BPS/);
  } finally {
    process.env.PLATFORM_FEE_BPS = previous;
  }
});

test('calcFee returns exact strings and reconstitutes the paid amount', () => {
  const previous = process.env.PLATFORM_FEE_BPS;
  try {
    process.env.PLATFORM_FEE_BPS = '500'; // 5%
    const fee = calcFee('0.75');
    assert.equal(fee.bps, 500);
    assert.equal(fee.feeAmount, '0.0375');
    assert.equal(fee.campaignAmount, '0.7125');
    // fee + net re-parses to exactly the contributed amount.
    assert.equal(
      parseAmountToStroops(fee.feeAmount) + parseAmountToStroops(fee.campaignAmount),
      parseAmountToStroops('0.75'),
    );

    const tiny = calcFee('0.0000002'); // 5% = 0.00000001 -> 0.1 stroop floors to 0
    assert.equal(tiny.feeAmount, '0');
    assert.equal(tiny.campaignAmount, '0.0000002');
    assert.equal(tiny.feeStroops, 0n);
  } finally {
    process.env.PLATFORM_FEE_BPS = previous;
  }
});

test('calcFee leaves the amount intact when the fee rate is zero', () => {
  const previous = process.env.PLATFORM_FEE_BPS;
  try {
    process.env.PLATFORM_FEE_BPS = '0';
    const fee = calcFee('10.0000001');
    assert.equal(fee.feeAmount, '0');
    assert.equal(fee.campaignAmount, '10.0000001');
    assert.equal(fee.feeStroops, 0n);
  } finally {
    process.env.PLATFORM_FEE_BPS = previous;
  }
});

test('path-payment sendMax split recomposes exactly (campaign + fee === sendMax)', () => {
  const previous = process.env.PLATFORM_FEE_BPS;
  try {
    process.env.PLATFORM_FEE_BPS = '500';
    // Mirrors buildUnsignedContributionPathPayment: same bps applied to sendMax.
    const sendMax = '12.0000003';
    const sendMaxStroops = parseAmountToStroops(sendMax);
    const { feeStroops, netStroops } = calculateFeeStroops(sendMaxStroops, getPlatformFeeBps());
    assert.equal(feeStroops + netStroops, sendMaxStroops);
    for (const part of [feeStroops, netStroops]) {
      assert.ok(!formatStroops(part).includes('e'), `no scientific notation: ${formatStroops(part)}`);
      assert.equal(parseAmountToStroops(formatStroops(part)), part);
    }
  } finally {
    process.env.PLATFORM_FEE_BPS = previous;
  }
});

// ---------------------------------------------------------------------------
// normalizeAmount — issue #63 acceptance criteria
// Covers the money-path normalization cases that were previously scattered as
// raw Number()/String()/parseFloat()/toFixed(7) coercions.
// ---------------------------------------------------------------------------

test('normalizeAmount strips trailing zeros', () => {
  assert.equal(normalizeAmount('10.0000000'), '10');
  assert.equal(normalizeAmount('1.5000000'), '1.5');
  assert.equal(normalizeAmount('0.1000000'), '0.1');
});

test('normalizeAmount round-trips with parseAmountToStroops + formatStroops', () => {
  for (const v of ['0', '0.0000001', '0.5', '10', '1234567890.1234567']) {
    assert.equal(normalizeAmount(v), formatStroops(parseAmountToStroops(v)));
  }
});

test('normalizeAmount rejects scientific notation (no silent float drift)', () => {
  assert.throws(() => normalizeAmount('1e-7'), Error);
  assert.throws(() => normalizeAmount('1E3'), Error);
});

test('normalizeAmount handles numeric input (Number type)', () => {
  // Equivalent to what Number()/String(amount) coercions used to do, but safe.
  assert.equal(normalizeAmount(10), '10');
  assert.equal(normalizeAmount(0.5), '0.5');
});

test('normalizeAmount rejects negative amounts', () => {
  assert.throws(() => normalizeAmount('-1'), Error);
  assert.throws(() => normalizeAmount('-0.1'), Error);
});

test('milestone toReleaseAmount-style stroop math: percentage of amount has no float drift', () => {
  // Mirrors the new toReleaseAmount implementation in milestones.js.
  // 25% of 1.0 raised should be exactly 0.25, not a float approximation.
  const raisedStroops = parseAmountToStroops('1.0');
  const scaledPct = BigInt(Math.round(25 * 1_000_000));
  const releasedStroops = (raisedStroops * scaledPct) / 100_000_000n;
  assert.equal(formatStroops(releasedStroops), '0.25');

  // 33.333% of 9.0 — float would drift, integer math is exact.
  const raised9 = parseAmountToStroops('9.0');
  const pct33 = BigInt(Math.round(33.333 * 1_000_000));
  const released33 = (raised9 * pct33) / 100_000_000n;
  // 9 * 0.33333 = 2.99997 stroops: 29999700n / 10000000 = 2.99997
  assert.equal(parseAmountToStroops(formatStroops(released33)), released33);
  // No scientific notation in the result.
  assert.ok(!formatStroops(released33).includes('e'));
});

test('slippage sendMax stroop math: SLIPPAGE_BPS applied without float drift', () => {
  // Mirrors the updated contributions.js sendMax calculation.
  const SLIPPAGE_BPS = 50; // 0.5%
  const sourceStroops = parseAmountToStroops('12.0000003');
  const maxSendStroops = (sourceStroops * BigInt(10000 + SLIPPAGE_BPS)) / 10000n;
  const maxSend = formatStroops(maxSendStroops);
  // result must be >= source, must be a valid Stellar decimal, no scientific notation.
  assert.ok(!maxSend.includes('e'));
  assert.ok(parseAmountToStroops(maxSend) >= sourceStroops);
  // Round-trip: formatStroops(parseAmountToStroops(result)) === result.
  assert.equal(normalizeAmount(maxSend), maxSend);
});
