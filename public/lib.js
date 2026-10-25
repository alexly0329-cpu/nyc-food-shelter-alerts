// Pure helpers, unit-tested in tests/lib.test.ts. No DOM access here.
const MESSAGES = {
  SCRIPT_NOT_CONFIRMED: 'Read the note out loud and tick the box before enrolling.',
  INVALID_PHONE: "That doesn't look like a US mobile number. Check the digits.",
  ZIP_NOT_NYC: "That ZIP isn't in New York City. Check it and try again.",
  INVALID_INPUT: 'Something in the form is missing or not valid. Check each field.',
  invalid_input: 'Something in the form is missing or not valid. Check each field.',
  PROVIDER_NOT_APPROVED: "Your organization isn't approved to send alerts yet.",
  invalid_credentials: 'Email or password is wrong.',
  email_taken: 'That email already has an application.',
  403: "Your account can't do that right now. Check the notice at the top of the Alerts page.",
};

export function errorMessage(code) {
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : 'Something went wrong. Try again.';
}

// Server validation texts that are fixed strings written by us, so safe to show as-is.
const SAFE_SERVER_TEXT = new Set([
  'endsAt must be after startsAt',
  'endsAt must be in the future',
  'startsAt must be within 24 hours',
  'startsAt and endsAt must be valid dates',
  'message must be 1-100 characters',
  'capacityCap must be an integer 5-500',
  'address required',
]);
export function friendlyError(code, message) {
  return SAFE_SERVER_TEXT.has(message) ? message : errorMessage(code);
}

/** True when [start, end] overlaps any 9 pm to 8 am window (Dates, local time). */
export function touchesQuietHours(start, end) {
  if (isNaN(start) || isNaN(end) || end <= start) return false;
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
  for (; day < end; day.setDate(day.getDate() + 1)) {
    const qs = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 21);
    const qe = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 8);
    if (start < qe && end > qs) return true;
  }
  return false;
}

export function alertStatusLabel(a) {
  if (a.verification === 'rejected') return { text: 'Rejected · address or details not accepted', tone: 'bad' };
  if (a.verification === 'needs_review' && a.hoursCheck === 'conflict') return { text: "Needs review · the hours we found don't match", tone: 'wait' };
  if (a.verification === 'needs_review') return { text: "Needs review · we couldn't confirm the address", tone: 'wait' };
  if (a.status === 'sent') return { text: 'Sent · address verified', tone: 'ok' };
  if (a.status === 'sending') return { text: 'Sending', tone: 'wait' };
  if (a.status === 'expired') return { text: 'Expired · not sent', tone: 'bad' };
  return { text: 'Queued', tone: 'wait' };
}

/** datetime-local value (browser local time, no zone) to a UTC ISO string; '' if invalid. */
export function toIso(v) {
  const d = new Date(v);
  return v && !isNaN(d) ? d.toISOString() : '';
}

/** True when the start is more than 24 hours after `now` (mirrors the server rule). */
export function startTooFar(startIso, now = new Date()) {
  return new Date(startIso).getTime() > now.getTime() + 24 * 3600 * 1000;
}
