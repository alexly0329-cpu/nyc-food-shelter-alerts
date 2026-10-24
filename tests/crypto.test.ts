import { describe, expect, it } from 'vitest';
import { decryptPhone, encryptPhone, phoneHash } from '../src/crypto.js';

const num = '+17185550142';

describe('phone crypto', () => {
  it('round-trips', () => {
    expect(decryptPhone(encryptPhone(num))).toBe(num);
  });

  it('uses a fresh IV each time', () => {
    expect(encryptPhone(num).equals(encryptPhone(num))).toBe(false);
  });

  it('throws on tampered ciphertext', () => {
    const b = encryptPhone(num);
    b[b.length - 1] ^= 1;
    expect(() => decryptPhone(b)).toThrow();
  });

  it('throws on tampered auth tag', () => {
    const b = encryptPhone(num);
    b[12] ^= 1;
    expect(() => decryptPhone(b)).toThrow();
  });

  it('throws on truncated input', () => {
    expect(() => decryptPhone(encryptPhone(num).subarray(0, 20))).toThrow();
    expect(() => decryptPhone(Buffer.alloc(0))).toThrow();
  });

  it('hash is stable and distinct per number', () => {
    expect(phoneHash(num)).toBe(phoneHash(num));
    expect(phoneHash(num)).not.toBe(phoneHash('+17185550143'));
    expect(phoneHash(num)).toMatch(/^[0-9a-f]{64}$/);
  });
});
