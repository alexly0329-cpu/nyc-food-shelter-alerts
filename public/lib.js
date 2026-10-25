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
  provider_not_approved: "That provider isn't approved, so this alert can't be sent.",
  not_needs_review: 'That alert was already handled.',
  geocode_failed: "We couldn't find that address. Fix it before approving.",
  not_found: 'That item no longer exists. Refresh the list.',
  enqueue_failed: "We couldn't queue that alert. It is still waiting for review. Try again.",
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
  if (a.status === 'sent') {
    // An admin-approved alert's address was not auto-verified, so plain "Sent"; never claim success when nothing arrived.
    return a.delivered === 0 && a.failed > 0 && a.failed >= a.texted ? { text: 'Not delivered · every send failed', tone: 'bad' } : { text: 'Sent', tone: 'ok' };
  }
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

/** Admin action errors: a 403 here means the account is not an admin (the staff 403 text points at the wrong page). */
export function adminErrorMessage(status, code) {
  return status === 403 ? "Your account can't do admin actions. Sign in as an admin." : errorMessage(code ?? '');
}

export function providerStatusLabel(status) {
  if (status === 'pending') return { text: 'Pending review', tone: 'wait' };
  if (status === 'approved') return { text: 'Approved', tone: 'ok' };
  if (status === 'suspended') return { text: 'Suspended', tone: 'bad' };
  return { text: 'Unknown status', tone: 'bad' };
}

/** `result` is the stored Tavily check ({ status, detail }) or null. */
export function tavilyLabel(result) {
  return result?.status === 'likely_legit'
    ? { text: 'Looks real on the web', tone: 'ok' }
    : { text: "We couldn't confirm it online", tone: 'wait' };
}

export function hoursLabel(h) {
  if (h === 'confirmed') return { text: 'Hours match', tone: 'ok' };
  if (h === 'conflict') return { text: "Hours don't match", tone: 'bad' };
  return { text: 'No hours found online', tone: 'wait' };
}

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
/** ISO instant to New York time like "Fri Oct 24, 5:00 PM"; '' if invalid. Built from parts so ICU spacing never leaks in. */
export function formatEt(iso) {
  const d = new Date(iso ?? NaN);
  if (isNaN(d)) return '';
  const p = Object.fromEntries(ET.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** Button name that tells two alerts of one provider apart. */
export function alertActionName(verb, providerName, startsAt) {
  const when = formatEt(startsAt);
  return `${verb} alert from ${providerName}${when ? ', ' + when : ''}`;
}

/** Provider-supplied JSON can hold anything: only strings and numbers are shown. */
export function displayText(v) {
  return (typeof v === 'string' && v !== '') || typeof v === 'number' ? String(v) : 'Not given';
}

export function addressLabel(geocoded) {
  return geocoded ? { text: 'Address located', tone: 'ok' } : { text: 'Address not located yet', tone: 'bad' };
}
