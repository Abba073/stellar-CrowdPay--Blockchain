import { describe, it, expect } from 'vitest';
import { parseAmountToStroops, formatStroops, calculateFee } from './amounts';

describe('amounts (frontend fee mirror)', () => {
  it('parses and formats exactly', () => {
    expect(parseAmountToStroops('0.75')).toBe(7500000n);
    expect(parseAmountToStroops('0.0000001')).toBe(1n);
    expect(formatStroops(375000n)).toBe('0.0375');
    expect(formatStroops(7125000n)).toBe('0.7125');
  });

  it('computes the same fee split the backend signs', () => {
    const { feeAmount, netAmount } = calculateFee('0.75', 500);
    expect(feeAmount).toBe('0.0375');
    expect(netAmount).toBe('0.7125');
    // fee + net === contributed amount, with no float drift.
    expect(parseAmountToStroops(feeAmount) + parseAmountToStroops(netAmount)).toBe(
      parseAmountToStroops('0.75')
    );
  });

  it('never renders scientific notation for tiny amounts', () => {
    const { feeAmount, netAmount } = calculateFee('0.0000002', 500);
    expect(feeAmount).toBe('0');
    expect(netAmount).toBe('0.0000002');
    expect(formatStroops(1n)).toBe('0.0000001');
  });
});
