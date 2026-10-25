import { describe, expect, it } from 'vitest';
import { adminErrorMessage, alertStatusLabel, errorMessage, formatEt, friendlyError, hoursLabel, providerStatusLabel, startTooFar, tavilyLabel, toIso, touchesQuietHours } from '../public/lib.js';

describe('errorMessage', () => {
  const cases: Record<string, string> = {
    SCRIPT_NOT_CONFIRMED: 'Read the note out loud and tick the box before enrolling.',
    INVALID_PHONE: "That doesn't look like a US mobile number. Check the digits.",
    ZIP_NOT_NYC: "That ZIP isn't in New York City. Check it and try again.",
    INVALID_INPUT: 'Something in the form is missing or not valid. Check each field.',
    invalid_input: 'Something in the form is missing or not valid. Check each field.',
    PROVIDER_NOT_APPROVED: "Your organization isn't approved to send alerts yet.",
    invalid_credentials: 'Email or password is wrong.',
    email_taken: 'That email already has an application.',
    403: "Your account can't do that right now. Check the notice at the top of the Alerts page.",
    nope: 'Something went wrong. Try again.',
    '': 'Something went wrong. Try again.',
  };
  for (const [code, msg] of Object.entries(cases)) it(`maps ${code || '(empty)'}`, () => expect(errorMessage(code)).toBe(msg));
});

describe('alertStatusLabel', () => {
  const l = (status: string, verification: string) => alertStatusLabel({ status, verification });
  it('needs_review', () => expect(l('pending', 'needs_review')).toEqual({ text: "Needs review · we couldn't confirm the address", tone: 'wait' }));
  it('needs_review with an hours conflict', () =>
    expect(alertStatusLabel({ status: 'pending', verification: 'needs_review', hoursCheck: 'conflict' })).toEqual({ text: "Needs review · the hours we found don't match", tone: 'wait' }));
  it('hours conflict only matters while in review', () =>
    expect(alertStatusLabel({ status: 'sent', verification: 'verified', hoursCheck: 'conflict' }).text).toBe('Sent · address verified'));
  it('needs_review with other hours values is unchanged', () =>
    expect(alertStatusLabel({ status: 'pending', verification: 'needs_review', hoursCheck: 'unconfirmed' }).text).toBe("Needs review · we couldn't confirm the address"));
  it('rejected', () => expect(l('pending', 'rejected').tone).toBe('bad'));
  it('queued', () => expect(l('pending', 'verified')).toEqual({ text: 'Queued', tone: 'wait' }));
  it('sending', () => expect(l('sending', 'verified')).toEqual({ text: 'Sending', tone: 'wait' }));
  it('sent', () => expect(l('sent', 'verified')).toEqual({ text: 'Sent · address verified', tone: 'ok' }));
  it('expired', () => expect(l('expired', 'verified')).toEqual({ text: 'Expired · not sent', tone: 'bad' }));
  it('review wins over send state', () => expect(l('sent', 'needs_review').tone).toBe('wait'));
});

describe('toIso', () => {
  it('converts a datetime-local value to UTC ISO', () => {
    const v = '2026-06-01T17:00';
    expect(toIso(v)).toBe(new Date(2026, 5, 1, 17, 0).toISOString());
    expect(toIso(v)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });
  it('returns empty string for empty/invalid input', () => {
    expect(toIso('')).toBe('');
    expect(toIso('garbage')).toBe('');
  });
});

describe('friendlyError', () => {
  it('shows known safe server text', () => expect(friendlyError('invalid_input', 'endsAt must be after startsAt')).toBe('endsAt must be after startsAt'));
  it('ignores unknown server text', () => expect(friendlyError('invalid_input', 'pg: secret')).toBe(errorMessage('invalid_input')));
  it('falls back without a message', () => expect(friendlyError('PROVIDER_NOT_APPROVED', undefined)).toBe(errorMessage('PROVIDER_NOT_APPROVED')));
});

describe('touchesQuietHours', () => {
  const t = (d: number, h: number, m = 0) => new Date(2026, 5, d, h, m);
  it('daytime is not quiet', () => expect(touchesQuietHours(t(1, 10), t(1, 18))).toBe(false));
  it('ends exactly at 9 pm is not quiet', () => expect(touchesQuietHours(t(1, 17), t(1, 21))).toBe(false));
  it('starts at 8 am is not quiet', () => expect(touchesQuietHours(t(1, 8), t(1, 12))).toBe(false));
  it('end inside window', () => expect(touchesQuietHours(t(1, 19), t(1, 22))).toBe(true));
  it('start inside window (early morning)', () => expect(touchesQuietHours(t(1, 6), t(1, 10))).toBe(true));
  it('8 pm to 9 am next day spans the window', () => expect(touchesQuietHours(t(1, 20), t(2, 9))).toBe(true));
  it('9 am to 8 pm next day spans the window', () => expect(touchesQuietHours(t(1, 9), t(2, 20))).toBe(true));
  it('invalid or reversed is false', () => {
    expect(touchesQuietHours(new Date(NaN), t(1, 1))).toBe(false);
    expect(touchesQuietHours(t(1, 10), t(1, 9))).toBe(false);
  });
});

describe('startTooFar and the 24h message', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  it('rejects beyond 24h only', () => {
    expect(startTooFar('2026-06-02T12:00:01Z', now)).toBe(true);
    expect(startTooFar('2026-06-02T11:59:00Z', now)).toBe(false);
    expect(startTooFar('2026-05-31T12:00:00Z', now)).toBe(false);
  });
  it('shows the server message as-is', () =>
    expect(friendlyError('INVALID_INPUT', 'startsAt must be within 24 hours')).toBe('startsAt must be within 24 hours'));
});

describe('providerStatusLabel', () => {
  it('maps each status to text and tone', () => {
    expect(providerStatusLabel('pending')).toEqual({ text: 'Pending review', tone: 'wait' });
    expect(providerStatusLabel('approved')).toEqual({ text: 'Approved', tone: 'ok' });
    expect(providerStatusLabel('suspended')).toEqual({ text: 'Suspended', tone: 'bad' });
  });
  it('unknown status is not shown as approved', () => expect(providerStatusLabel('weird')).toEqual({ text: 'Unknown status', tone: 'bad' }));
});

describe('tavilyLabel', () => {
  it('likely_legit', () => expect(tavilyLabel({ status: 'likely_legit', detail: 'x' })).toEqual({ text: 'Looks real on the web', tone: 'ok' }));
  it('flagged, missing or malformed', () => {
    const bad = { text: "We couldn't confirm it online", tone: 'wait' };
    expect(tavilyLabel({ status: 'flagged', detail: 'x' })).toEqual(bad);
    expect(tavilyLabel(null)).toEqual(bad);
    expect(tavilyLabel(undefined)).toEqual(bad);
    expect(tavilyLabel('likely_legit')).toEqual(bad);
  });
});

describe('hoursLabel', () => {
  it('maps hours checks', () => {
    expect(hoursLabel('confirmed')).toEqual({ text: 'Hours match', tone: 'ok' });
    expect(hoursLabel('unconfirmed')).toEqual({ text: 'No hours found online', tone: 'wait' });
    expect(hoursLabel('conflict')).toEqual({ text: "Hours don't match", tone: 'bad' });
  });
  it('missing is treated as no hours found', () => {
    expect(hoursLabel(null).text).toBe('No hours found online');
    expect(hoursLabel(undefined).text).toBe('No hours found online');
  });
});

describe('formatEt', () => {
  it('winter instant (EST, UTC-5)', () => expect(formatEt('2026-01-15T22:00:00Z')).toBe('Thu Jan 15, 5:00 PM'));
  it('summer instant (EDT, UTC-4)', () => expect(formatEt('2026-10-24T21:00:00Z')).toBe('Sat Oct 24, 5:00 PM'));
  it('spring forward 2026-03-08: 1:59 EST then 3:00 EDT', () => {
    expect(formatEt('2026-03-08T06:59:00Z')).toBe('Sun Mar 8, 1:59 AM');
    expect(formatEt('2026-03-08T07:00:00Z')).toBe('Sun Mar 8, 3:00 AM');
  });
  it('fall back 2026-11-01: 1:30 EDT, then 1:30 EST, then 2:00 EST', () => {
    expect(formatEt('2026-11-01T05:30:00Z')).toBe('Sun Nov 1, 1:30 AM');
    expect(formatEt('2026-11-01T06:30:00Z')).toBe('Sun Nov 1, 1:30 AM');
    expect(formatEt('2026-11-01T07:00:00Z')).toBe('Sun Nov 1, 2:00 AM');
  });
  it('uses New York midnight, not UTC date', () => expect(formatEt('2026-07-01T03:59:00Z')).toBe('Tue Jun 30, 11:59 PM'));
  it('uses a plain ASCII space before AM/PM', () => expect(formatEt('2026-01-15T22:00:00Z')).not.toMatch(/[^\x20-\x7e]/));
  it('invalid input gives an empty string', () => {
    expect(formatEt('nope')).toBe('');
    expect(formatEt(undefined)).toBe('');
    expect(formatEt(null)).toBe('');
  });
});

describe('admin error mappings', () => {
  const cases: Record<string, string> = {
    provider_not_approved: "That provider isn't approved, so this alert can't be sent.",
    not_needs_review: 'That alert was already handled.',
    geocode_failed: "We couldn't find that address. Fix it before approving.",
    not_found: 'That item no longer exists. Refresh the list.',
    enqueue_failed: "We couldn't queue that alert. It is still waiting for review. Try again.",
  };
  for (const [code, msg] of Object.entries(cases)) it(`errorMessage maps ${code}`, () => expect(errorMessage(code)).toBe(msg));
  it('403 on an admin action says to sign in as an admin', () =>
    expect(adminErrorMessage(403, 'forbidden')).toBe("Your account can't do admin actions. Sign in as an admin."));
  it('other statuses use the body code', () => {
    expect(adminErrorMessage(409, 'not_needs_review')).toBe('That alert was already handled.');
    expect(adminErrorMessage(400, 'INVALID_PHONE')).toBe(errorMessage('INVALID_PHONE'));
    expect(adminErrorMessage(0, undefined)).toBe('Something went wrong. Try again.');
  });
});
