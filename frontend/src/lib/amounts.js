/**
 * amounts.js
 *
 * Exact decimal math for Stellar amounts, mirroring backend/src/utils/amounts.js
 * so the fee preview shown in the UI matches the exact split the backend signs
 * for on-chain (fee + campaign net always equals the contributed amount).
 */

export const STROOPS_PER_UNIT = 10000000n;
export const MAX_DECIMALS = 7;

const DECIMAL_NUMBER_RE = /^\d+(\.\d+)?$/;

/** Parse a decimal amount (string) into stroops (BigInt), noexcept for display code. */
export function parseAmountToStroops(input) {
  let raw;
  if (typeof input === 'string') {
    raw = input.trim();
  } else if (typeof input === 'number' && Number.isFinite(input)) {
    raw = String(input);
  } else {
    throw new TypeError(`Amount must be a number or decimal string, got: ${input}`);
  }

  if (raw.startsWith('+')) raw = raw.slice(1);
  if (!DECIMAL_NUMBER_RE.test(raw) || raw.includes('e') || raw.includes('E')) {
    throw new Error(
      `Invalid amount "${input}": expected a decimal number with at most ${MAX_DECIMALS} decimal places`
    );
  }

  const [intPart, fracPart = ''] = raw.split('.');
  if (fracPart.length > MAX_DECIMALS) {
    throw new Error(
      `Invalid amount "${input}": expected a decimal number with at most ${MAX_DECIMALS} decimal places`
    );
  }
  const frac = (fracPart + '0'.repeat(MAX_DECIMALS)).slice(0, MAX_DECIMALS);
  return BigInt(intPart) * STROOPS_PER_UNIT + BigInt(frac || '0');
}

/** Format stroops (BigInt) as a decimal string with trailing zeros trimmed. */
export function formatStroops(stroops) {
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
 * Split a decimal amount into { feeAmount, netAmount } decimal strings for the
 * given fee rate in basis points. Mirrors backend calculateFeeStroops().
 */
export function calculateFee(amount, bps) {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new Error(`Invalid fee rate (bps): expected an integer between 0 and 10000, got ${bps}`);
  }
  const amountStroops = parseAmountToStroops(amount);
  const feeStroops = (amountStroops * BigInt(bps)) / 10000n;
  return {
    feeAmount: formatStroops(feeStroops),
    netAmount: formatStroops(amountStroops - feeStroops),
  };
}
