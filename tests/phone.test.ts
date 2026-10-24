import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/phone.js';

describe('normalizePhone', () => {
  it.each(['(718) 555-0142', '718-555-0142', '+1 718 555 0142', '17185550142', '7185550142'])(
    'normalizes %s',
    (raw) => expect(normalizePhone(raw)).toBe('+17185550142'),
  );

  it.each(['555-0142', 'abc', '+44 20 7946 0958', '', '27185550142'])('rejects %s', (raw) =>
    expect(normalizePhone(raw)).toBeNull(),
  );
});
