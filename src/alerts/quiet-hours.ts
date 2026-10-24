const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23',
});

function nyWall(d: Date) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, Number(x.value)]));
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour! };
}

/** The instant of 08:00 America/New_York on the given wall-clock date (08:00 never falls in a DST gap or overlap). */
function eightAmEt(y: number, m: number, d: number): Date {
  for (const offset of [4, 5]) {
    const c = new Date(Date.UTC(y, m - 1, d, 8 + offset));
    const w = nyWall(c);
    if (w.d === d && w.h === 8) return c;
  }
  throw new Error('unreachable: 08:00 ET not found');
}

export type QuietHoursDecision = { action: 'send' } | { action: 'defer'; until: Date } | { action: 'expire' };

/** Quiet hours are 21:00 up to (not including) 08:00 America/New_York. */
export function quietHoursDecision(sendAt: Date, endsAt: Date, urgent: boolean): QuietHoursDecision {
  if (sendAt.getTime() >= endsAt.getTime()) return { action: 'expire' };
  const w = nyWall(sendAt);
  const quiet = w.h >= 21 || w.h < 8;
  if (urgent || !quiet) return { action: 'send' };
  // Next calendar day (via UTC date math on the wall date) when evening, same day when after midnight.
  const day = new Date(Date.UTC(w.y, w.m - 1, w.d + (w.h >= 21 ? 1 : 0)));
  const until = eightAmEt(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
  return endsAt.getTime() > until.getTime() ? { action: 'defer', until } : { action: 'expire' };
}
