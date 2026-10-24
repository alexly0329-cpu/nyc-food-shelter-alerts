const ALLOWED = new Set(['alertId', 'deliveryId', 'channel', 'route', 'reason', 'status']);

// 7+ digits, allowing a couple of separator characters between them, so "(718) 555-1234" is caught too.
const PHONE_LIKE = /\d(?:[\s().-]{0,2}\d){6,}/g;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One JSON line on stdout for hosting alerts. Only whitelisted fields; never phone numbers or message text. */
export function logEvent(
  event: 'send_failed' | 'webhook_error' | 'webhook_rejected' | 'queue_error',
  fields: Record<string, string | number> = {},
): void {
  const out: Record<string, string | number> = { event, ts: new Date().toISOString() };
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED.has(k)) continue;
    out[k] = typeof v === 'string' ? (UUID.test(v) ? v : v.replace(PHONE_LIKE, '[redacted]').slice(0, 200)) : v; // a bare UUID is an id we generated; the digit rule would mangle it
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}
