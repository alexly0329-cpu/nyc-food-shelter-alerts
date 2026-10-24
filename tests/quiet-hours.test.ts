import { describe, expect, it } from 'vitest';
import { quietHoursDecision } from '../src/alerts/quiet-hours.js';

// June 2026 is EDT (UTC-4): 15:00 ET = 19:00Z.
const et = (day: number, h: number, m = 0) => new Date(Date.UTC(2026, 5, day, h + 4, m));
const nyParts = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).format(d);

describe('quietHoursDecision', () => {
  it('3 pm sends', () => expect(quietHoursDecision(et(1, 15), et(1, 18), false)).toEqual({ action: 'send' }));
  it('10 pm not urgent, ends 11 pm: expire', () =>
    expect(quietHoursDecision(et(1, 22), et(1, 23), false)).toEqual({ action: 'expire' }));
  it('10 pm not urgent, ends 10 am next day: defer to 8 am', () =>
    expect(quietHoursDecision(et(1, 22), et(2, 10), false)).toEqual({ action: 'defer', until: et(2, 8) }));
  it('10 pm urgent sends', () => expect(quietHoursDecision(et(1, 22), et(2, 10), true)).toEqual({ action: 'send' }));
  it('exactly 8:00 sends', () => expect(quietHoursDecision(et(1, 8), et(1, 12), false)).toEqual({ action: 'send' }));
  it('exactly 21:00 is quiet', () =>
    expect(quietHoursDecision(et(1, 21), et(2, 10), false)).toEqual({ action: 'defer', until: et(2, 8) }));
  it('2 am defers to 8 am same day', () =>
    expect(quietHoursDecision(et(2, 2), et(2, 12), false)).toEqual({ action: 'defer', until: et(2, 8) }));
  it('2 am, ends exactly at 8 am: expire', () =>
    expect(quietHoursDecision(et(2, 2), et(2, 8), false)).toEqual({ action: 'expire' }));
  it('sendAt >= endsAt expires even when urgent', () => {
    expect(quietHoursDecision(et(1, 15), et(1, 15), true)).toEqual({ action: 'expire' });
    expect(quietHoursDecision(et(1, 16), et(1, 15), true)).toEqual({ action: 'expire' });
  });

  it.each([
    ['spring forward', new Date('2026-03-08T05:30:00Z'), new Date('2026-03-08T20:00:00Z')], // 12:30 am EST, before the jump
    ['spring forward evening before', new Date('2026-03-08T02:30:00Z'), new Date('2026-03-08T20:00:00Z')],
    ['fall back', new Date('2026-11-01T05:30:00Z'), new Date('2026-11-01T20:00:00Z')], // 1:30 am EDT, ambiguous hour
    ['fall back later repeat', new Date('2026-11-01T06:30:00Z'), new Date('2026-11-01T20:00:00Z')], // 1:30 am EST
  ])('DST %s resolves to 8:00 ET', (_n, sendAt, endsAt) => {
    const r = quietHoursDecision(sendAt, endsAt, false);
    expect(r.action).toBe('defer');
    if (r.action === 'defer') {
      expect(nyParts(r.until)).toBe('08:00');
      expect(r.until.getTime()).toBeGreaterThan(sendAt.getTime());
      expect(r.until.getTime() - sendAt.getTime()).toBeLessThan(10 * 3_600_000);
    }
  });
});
