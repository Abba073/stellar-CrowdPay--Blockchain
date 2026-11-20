/**
 * amounts.js
 *
 * Exact decimal math for Stellar amounts, applied to the platform fee split,
 * contribution limits and target accounting.
 *
 * Stellar amounts carry up to 7 decimal places (1 unit = 10,000,000 stroops).
 * Floating point math (`parseFloat` * bps / 10000 `.toFixed(7)`) drifts on the
 * order of one stroop and can make fee + net != amount, so fee math is done in
 * integer stroops (BigInt) here. Inputs are converted to stroops and results
 * are formatted back to decimal strings, never floats.
 */

const STROOPS_PER_UNIT = 10000000n;
const MAX_DECIMALS = 7;
const DECIMAL_NUMBER_RE = /^\d+(\.\d+)?$/;
const FEE_DENOMINATOR = 10000n;

/**
 * Thrown for malformed amounts. Carries status 422 / VALIDATION_ERROR and a
 * per-field message, so the error handler answers a client error instead of
 * a 500 when user input reaches the parser.
 */
class InvalidAmountError extends Error {
  constructor(message, field = 'amount') {
    super(message);
    this.name = 'InvalidAmountError';
    this.status = 422;
    this.code = 'VALIDATION_ERROR';
    this.field = field;
    this.fields = { [field]: message };
  }
}

/**
 * Parse a decimal amount into stroops (BigInt).
 *
 * Accepts plain decimal strings (e.g. "10.5", "0.0000001") with at most 7
 * decimal places. Extra fractional digits are truncated toward zero, matching
 * NUMERIC(20,7) storage and avoiding float rounding. Scientific notation,
 * negatives, and non-numeric input throw.
 */
function parseAmountToStroops(input, field = 'amount') {
  let raw;
  if (typeof input === 'string') {
    raw = input.trim();
  } else if (typeof input === 'number' && Number.isFinite(input)) {
    raw = String(input);
  } else {
    throw new InvalidAmountError(`${field} must be a number or decimal string`, field);
  }

  if (raw.startsWith('+')) raw = raw.slice(1);
  if (!DECIMAL_NUMBER_RE.test(raw) || raw.includes('e') || raw.includes('E')) {
    throw new InvalidAmountError(
      `${field} must be a decimal number with at most ${MAX_DECIMALS} decimal places, e.g. "10.5"`,
      field,
    );
  }

  const [intPart, fracPart = ''] = raw.split('.');
  const frac = (fracPart + '0'.repeat(MAX_DECIMALS)).slice(0, MAX_DECIMALS);
  return BigInt(intPart) * STROOPS_PER_UNIT + BigInt(frac || '0');
}

/**
 * Non-throwing parse: stroops, or null when the input is not a valid amount.
 */
function tryParseAmountToStroops(input) {
  try {
    return parseAmountToStroops(input);
  } catch (err) {
    if (err instanceof InvalidAmountError) return null;
    throw err;
  }
}

/**
 * Validates a user-supplied amount with the same rules the parser uses
 * (plain decimal, at most 7 decimal places, no exponent) and, by default,
 * requires it to be greater than zero. Returns the stroops value or throws
 * InvalidAmountError naming the field.
 */
function parseUserAmount(input, field = 'amount', { allowZero = false } = {}) {
  const stroops = parseAmountToStroops(input, field);
  if (!allowZero && stroops <= 0n) {
    throw new InvalidAmountError(`${field} must be greater than zero`, field);
  }
  return stroops;
}

/**
 * Format stroops (BigInt) as a decimal string with trailing zeros trimmed,
 * e.g. 500000000n -> "50", 1n -> "0.0000001", 0n -> "0".
 */
function formatStroops(stroops) {
  if (typeof stroops !== 'bigint') stroops = BigInt(stroops);
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const intPart = abs / STROOPS_PER_UNIT;
  const fracPart = (abs % STROOPS_PER_UNIT)
    .toString()
    .padStart(MAX_DECIMALS, '0')
    .replace(/0+$/, '');
  const body = fracPart ? `${intPart}.${fracPart}` : intPart.toString();
  return negative ? `-${body}` : body;
}

/**
 * Split an amount (in stroops) into platform fee and campaign net using exact
 * integer math. The fee is floored so fee + net always equals amount exactly.
 */
function calculateFeeStroops(amountStroops, bps) {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new Error(`Invalid fee rate (bps): expected an integer between 0 and 10000, got ${bps}`);
  }
  const feeStroops = (amountStroops * BigInt(bps)) / FEE_DENOMINATOR;
  return {
    feeStroops,
    netStroops: amountStroops - feeStroops,
  };
}

/**
 * Platform fee rate in basis points, validated once from the environment.
 * Single source of the fee configuration for both fee math and config reads.
 */
function getPlatformFeeBps() {
  const raw = process.env.PLATFORM_FEE_BPS || '0';
  const bps = parseInt(raw, 10);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new Error(`Invalid PLATFORM_FEE_BPS: "${raw}" (expected an integer between 0 and 10000)`);
  }
  return bps;
}

/**
 * Normalise an amount to a canonical Stellar decimal string (at most 7 decimal
 * places, no trailing zeros, no scientific notation).  Equivalent to
 * formatStroops(parseAmountToStroops(input)) but reads more clearly at call
 * sites that don't need the intermediate stroop value.
 *
 * Throws for invalid input (same rules as parseAmountToStroops).
 *
 * @param {string|number} input  Raw amount from user input or DB
 * @returns {string}  e.g. "10.5", "0.0000001", "0"
 */
function normalizeAmount(input) {
  return formatStroops(parseAmountToStroops(input));
}

module.exports = {
  STROOPS_PER_UNIT,
  MAX_DECIMALS,
  InvalidAmountError,
  parseAmountToStroops,
  tryParseAmountToStroops,
  parseUserAmount,
  formatStroops,
  normalizeAmount,
  calculateFeeStroops,
  getPlatformFeeBps,
};