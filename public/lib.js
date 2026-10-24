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
};

export function errorMessage(code) {
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : 'Something went wrong. Try again.';
}

export function alertStatusLabel(a) {
  if (a.verification === 'rejected') return { text: 'Rejected · address or details not accepted', tone: 'bad' };
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
