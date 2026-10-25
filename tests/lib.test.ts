import { describe, expect, it } from 'vitest';
import { alertStatusLabel, errorMessage, friendlyError, startTooFar, toIso, touchesQuietHours } from '../public/lib.js';

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
