import { describe, expect, it } from 'vitest';
import { alertStatusLabel, errorMessage, toIso } from '../public/lib.js';

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
    nope: 'Something went wrong. Try again.',
    '': 'Something went wrong. Try again.',
  };
  for (const [code, msg] of Object.entries(cases)) it(`maps ${code || '(empty)'}`, () => expect(errorMessage(code)).toBe(msg));
});

describe('alertStatusLabel', () => {
  const l = (status: string, verification: string) => alertStatusLabel({ status, verification });
  it('needs_review', () => expect(l('pending', 'needs_review')).toEqual({ text: "Needs review · we couldn't confirm the address", tone: 'wait' }));
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
