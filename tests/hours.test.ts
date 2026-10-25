import { describe, expect, it } from 'vitest';
import { checkHoursInText } from '../src/integrations/hours.js';

// 2026-11-02 is a Monday. NY is EST (UTC-5) from 2026-11-01, EDT (UTC-4) before.
const at = (iso: string) => new Date(iso);
// Mon 2026-11-02 17:30 NY = 22:30Z
const monEve = at('2026-11-02T22:30:00Z');
const end = (d: Date) => new Date(d.getTime() + 3_600_000);
const check = (text: string, start: Date = monEve) => checkHoursInText(text, start, end(start));

describe('checkHoursInText: formats', () => {
  it.each([
    ['5pm-7pm', 'confirmed'],
    ['5:00 PM – 7:00 PM', 'confirmed'],
    ['5-7pm', 'confirmed'],
    ['Hours: 9am to 5pm', 'conflict'],
    ['9am-6pm', 'confirmed'],
    ['9 a.m. - 6 p.m.', 'confirmed'],
    ['5:00 PM through 7:00 PM', 'confirmed'],
    ['Mon-Fri 5pm-7pm', 'confirmed'],
    ['Monday: 5-7pm', 'confirmed'],
    ['Mon–Fri 9am–6pm', 'confirmed'],
    ['Monday through Friday 5pm to 7pm', 'confirmed'],
    ['Mon thru Wed 5pm-7pm', 'confirmed'],
    ['Mon, Wed & Fri 5pm-7pm', 'confirmed'],
    ['Tues and Thurs 5pm-7pm', 'conflict'],
    ['Tue/Thu 5pm-7pm', 'conflict'],
    ['Sat 5pm-7pm', 'conflict'],
    ['Weekdays 5pm-7pm', 'confirmed'],
    ['Weekends 5pm-7pm', 'conflict'],
    ['Daily 5pm-7pm', 'confirmed'],
    ['Open every day 5pm-7pm', 'confirmed'],
    ['Open 7 days 5pm - 7pm', 'confirmed'],
    ['5pm-7pm Mon-Fri', 'confirmed'],
    ['5pm-7pm Sat & Sun', 'conflict'],
    ['Open 24 hours', 'confirmed'],
    ['open 24/7', 'confirmed'],
    ['Sat-Sun 24 hours', 'conflict'],
    ['noon to midnight', 'confirmed'],
    ['noon-5pm', 'conflict'],
    ['Mon-Fri 9am-12pm, 1pm-6pm', 'confirmed'],
    ['Mon-Fri 9am-12pm, 1pm-4pm', 'conflict'],
    ['Mon-Fri 9-5, Sat 5pm-7pm', 'unconfirmed'],
    ['Mon-Fri 9am-5pm, Mon 5pm-7pm', 'confirmed'],
    ['Mon 9am-12pm; Tue 5pm-7pm', 'conflict'],
    ['Sat-Mon 5pm-7pm', 'confirmed'],
    ['Saturdays 5pm-7pm', 'conflict'],
  ])('%s -> %s', (text, expected) => {
    expect(check(text)).toBe(expected);
  });

  it('bare times apply to every day, alongside explicit days', () => {
    expect(check('Sat 10am-2pm. Also 5pm-7pm')).toBe('confirmed');
    expect(check('Sat 10am-2pm. Also 9am-11am')).toBe('conflict');
  });
  it('inclusive open and close', () => {
    expect(check('5pm-5:30pm', at('2026-11-02T22:00:00Z'))).toBe('confirmed');
    expect(check('5pm-5:30pm', at('2026-11-02T22:30:00Z'))).toBe('confirmed');
    expect(check('5pm-5:30pm', at('2026-11-02T22:31:00Z'))).toBe('conflict');
    expect(check('5pm-5:30pm', at('2026-11-02T21:59:00Z'))).toBe('conflict');
  });
  it('am/pm inferred from the closing time', () => {
    expect(check('9-5pm', at('2026-11-02T15:00:00Z'))).toBe('confirmed'); // 10am NY
    expect(check('11-1pm', at('2026-11-02T17:00:00Z'))).toBe('confirmed'); // noon NY
  });
});

describe('checkHoursInText: unreadable hours downgrade a conflict', () => {
  const mon10 = at('2026-11-02T15:00:00Z'); // Mon 10:00 NY
  it.each([
    ['Mon-Fri 9-5, Sat 10am-2pm'],
    ['M-F 9-5. Saturday 10am - 2pm'],
    ['Mon-Fri 10-12, Sat 10am-2pm'],
    ['Mon-Fri 9:00-5:00, Sat 10am-2pm'],
  ])('%s -> unconfirmed', (text) => expect(check(text, mon10)).toBe('unconfirmed'));
  it('a day label never paired with a time downgrades', () => expect(check('Sat 10am-2pm. Closed Sundays', mon10)).toBe('unconfirmed'));
  it('confirmed stays confirmed alongside unreadable hours', () => expect(check('Mon 9-5, Mon 9am-11am', mon10)).toBe('confirmed'));
  it('fully parsed text still conflicts', () => expect(check('Mon-Fri 1pm-5pm, Sat 10am-2pm', mon10)).toBe('conflict'));
  it('dates and phone numbers do not downgrade', () => expect(check('Since 2026-10-24 call 718-555-1234. Sat 10am-2pm', mon10)).toBe('conflict'));
  it('24-hour clock with an hour above 12 is read', () => expect(check('Mon 09:00-17:00', mon10)).toBe('confirmed'));
});

describe('checkHoursInText: overnight', () => {
  const text = 'Shelter open 8 PM – 8 AM';
  it('same evening', () => expect(check(text, at('2026-11-03T02:00:00Z'))).toBe('confirmed')); // Mon 9pm NY
  it('after midnight, wrapped from the previous day', () => expect(check(text, at('2026-11-03T11:00:00Z'))).toBe('confirmed')); // Tue 6am NY
  it('daytime is a conflict', () => expect(check(text, at('2026-11-03T17:00:00Z'))).toBe('conflict')); // Tue noon NY
});

describe('checkHoursInText: wrap day logic', () => {
  it('Fri overnight covers Sat 6am but not Fri 6am', () => {
    const t = 'Fri 8 PM - 8 AM';
    expect(check(t, at('2026-11-07T11:00:00Z'))).toBe('confirmed'); // Sat 2026-11-07 6am NY
    expect(check(t, at('2026-11-06T11:00:00Z'))).toBe('conflict'); // Fri 6am NY
  });
});

describe('checkHoursInText: unconfirmed and junk', () => {
  it.each([
    [''],
    ['great place, call 718-555-1234 or visit 214 Marcy Avenue'],
    ['Since 2026-10-24, meals cost $5'],
    ['Open 10-12 people at 214 Marcy Ave'],
    ['Call us 24 hours in advance'],
    ['Mon-Fri'],
  ])('%j -> unconfirmed', (text) => {
    expect(check(text)).toBe('unconfirmed');
  });
  it('uses New York time, including DST', () => {
    // 2026-06-01 Monday; 21:00Z = 5pm EDT
    expect(checkHoursInText('5pm-6pm', at('2026-06-01T21:00:00Z'), at('2026-06-01T22:00:00Z'))).toBe('confirmed');
    expect(checkHoursInText('5pm-6pm', at('2026-06-01T17:00:00Z'), at('2026-06-01T18:00:00Z'))).toBe('conflict');
  });
  it('never throws, caps work on huge adversarial input', () => {
    const inputs = [
      ' '.repeat(100_000),
      '1 '.repeat(50_000),
      'mon-'.repeat(25_000),
      '5:'.repeat(50_000) + 'pm',
      '5pm-'.repeat(25_000),
      'mon, '.repeat(20_000),
      `${'9 '.repeat(20_000)}am-`,
      '–'.repeat(100_000),
    ];
    for (const s of inputs) {
      const t0 = performance.now();
      expect(['confirmed', 'conflict', 'unconfirmed']).toContain(check(s));
      expect(performance.now() - t0).toBeLessThan(5000);
    }
  });
  it('invalid dates do not throw', () => {
    expect(checkHoursInText('5pm-7pm', new Date(NaN), new Date(NaN))).toBe('unconfirmed');
  });
});
