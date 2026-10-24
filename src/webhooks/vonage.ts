import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { phoneHash } from '../crypto.js';
import { normalizePhone } from '../phone.js';
import { stopRecipient } from '../recipients/revoke.js';

const STOP_WORDS = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'CANCELALL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'ALTO', 'PARAR', 'CANCELAR', 'BAJA',
]);
const HELP_WORDS = new Set(['HELP', 'AYUDA']);
const CONFIRM = "You're unsubscribed from NYC food and shelter alerts. No more messages will be sent.";
const TERMS = 'free food and shelter alerts for NYC, up to 1 message a day. Msg&data rates may apply.';
const GENERIC_HELP = 'NYC food and shelter alerts, up to 1 message a day. Msg&data rates may apply. Reply STOP to opt out.';

// NFKC (fullwidth to ASCII), drop format chars (zero-width), punctuation and ALL whitespace, so "STOP ALL" is STOPALL.
const keyword = (text: unknown) =>
  typeof text === 'string' ? text.normalize('NFKC').replace(/[\p{Cf}\p{P}\p{S}\s]/gu, '').toUpperCase() : '';

const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

export function isStopKeyword(text: string): boolean {
  return STOP_WORDS.has(keyword(text));
}

export async function handleInbound(deps: { db: pg.Pool }, msg: { from: string; text: string }): Promise<{ reply: string | null }> {
  const word = keyword(msg.text);
  const stop = STOP_WORDS.has(word);
  if (!stop && !HELP_WORDS.has(word)) return { reply: null };
  const e164 = typeof msg.from === 'string' ? normalizePhone(msg.from) : null;

  if (stop) {
    if (e164) await stopRecipient(deps.db, e164);
    return { reply: CONFIRM };
  }

  if (!e164) return { reply: GENERIC_HELP };
  const r = await deps.db.query(
    `SELECT p.name, p.contact FROM recipients r JOIN providers p ON p.id = r.enrolled_by_provider_id WHERE r.phone_hash = $1`,
    [phoneHash(e164)],
  );
  if (!r.rowCount) return { reply: GENERIC_HELP };
  const { name, contact } = r.rows[0] as { name: string; contact: string };
  const pname = clip(name, 60);
  return { reply: `${pname}: ${TERMS} Questions? ${contactLine(pname, contact)} Reply STOP to opt out.` };
}

// contact is JSON text from the apply form, but older rows may hold a bare name.
function contactLine(providerName: string, contact: string): string {
  let c: unknown = null;
  try { c = JSON.parse(contact); } catch { /* bare-name contact */ }
  const o = c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {};
  if (typeof o.phone === 'string' && clip(o.phone, 40)) return `Call ${clip(o.phone, 40)}.`;
  const who = typeof o.contactName === 'string' && clip(o.contactName, 60) ? clip(o.contactName, 60) : providerName;
  return `Contact ${who}.`;
}

const DELIVERED = new Set(['delivered', 'read', 'completed']);
const FAILED = new Set(['failed', 'rejected', 'undeliverable', 'busy', 'unanswered', 'timeout', 'cancelled']);

export async function handleStatus(deps: { db: pg.Pool }, evt: { messageId: string; status: string }): Promise<void> {
  const s = String(evt.status ?? '').toLowerCase();
  const next = DELIVERED.has(s) ? 'delivered' : FAILED.has(s) ? 'failed' : null;
  if (!next || !evt.messageId) return;
  await deps.db.query(`UPDATE deliveries SET status = $1 WHERE vonage_id = $2 AND status = 'queued'`, [next, evt.messageId]);
}

/** HS256 JWT from Vonage's `Authorization: Bearer` header; binds the signature to rawBody via payload_hash. */
export function verifyVonageSignature(rawBody: string, token: string, secret: string, now: Date = new Date()): boolean {
  try {
    if (!secret || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [h, p, sig] = parts;
    if (JSON.parse(Buffer.from(h, 'base64url').toString()).alg !== 'HS256') return false;
    const want = createHmac('sha256', secret).update(`${h}.${p}`).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (payload.payload_hash !== createHash('sha256').update(rawBody).digest('hex')) return false;
    return typeof payload.iat === 'number' && Math.abs(now.getTime() / 1000 - payload.iat) <= 300;
  } catch {
    return false;
  }
}
