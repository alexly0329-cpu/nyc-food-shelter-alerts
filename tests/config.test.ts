import { describe, expect, it } from 'vitest';
import { parseMaxAlertKm } from '../src/config.js';

describe('parseMaxAlertKm', () => {
  it('defaults to 5 when unset or empty', () => {
    expect(parseMaxAlertKm(undefined)).toBe(5);
    expect(parseMaxAlertKm('')).toBe(5);
  });
  it('accepts positive floats', () => {
    expect(parseMaxAlertKm('2.5')).toBe(2.5);
    expect(parseMaxAlertKm('12')).toBe(12);
  });
  it.each(['0', '-1', 'abc', 'NaN', 'Infinity', '5km'])('rejects %s', (v) => {
    expect(() => parseMaxAlertKm(v)).toThrow(/MAX_ALERT_KM/);
  });
});
