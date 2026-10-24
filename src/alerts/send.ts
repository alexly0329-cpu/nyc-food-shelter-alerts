import type { Pool } from 'pg';
import { config } from '../config.js';
import { decryptPhone } from '../crypto.js';
import { withTx } from '../db.js';
import { quietHoursDecision } from './quiet-hours.js';
import { selectRecipients } from './select.js';

export interface Sender {
  sendSms(to: string, text: string): Promise<{ id: string }>;
  startCall(to: string, text: string, language: string): Promise<{ id: string }>;
}

export interface SendJobDeps {
  db: Pool;
  sender: Sender;
  enqueue: (alertId: string, runAt: Date) => Promise<void>;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });

/** `5:00 PM` in America/New_York (built from parts: newer ICU puts a narrow no-break space before PM). */
function startTime(d: Date): string {
  const p = Object.fromEntries(timeFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

export interface AlertText { providerName: string; message: string; address: string; startsAt: Date }

/** The message is sent exactly as the provider wrote it; only the opt-out sentence differs by channel. */
export function buildMessageText(a: AlertText, channel: 'sms' | 'voice'): string {
  const body = `${a.providerName}: ${a.message} ${a.address}, ${startTime(a.startsAt)}.`;
  if (channel === 'sms') return `${body} Reply STOP to opt out.`;
  const number = process.env.VONAGE_NUMBER;
  return number
    ? `${body} To stop these calls, text STOP to ${number}.`
    : `${body} To stop these calls, ask the organization that enrolled you.`;
}

const LOCALES: Record<string, string> = {
  English: 'en-US', 'Español': 'es-US', '中文': 'zh-CN', 'Русский': 'ru-RU',
  en: 'en-US', es: 'es-US', zh: 'zh-CN', ru: 'ru-RU',
};
/** Text-to-speech locale only; never changes the text. */
export const voiceLocale = (language: string): string => LOCALES[language] ?? 'en-US';

// Serializes recipient selection across alerts: under READ COMMITTED another alert's uncommitted
// queued rows are invisible to the 24h exclusion, so two alerts could otherwise pick the same person.
const SELECT_LOCK = 7283002;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSendJob(deps: SendJobDeps, alertId: string): Promise<void> {
  const { db, sender } = deps;
  const sleep = deps.sleep ?? defaultSleep;

  const found = await db.query(
    `SELECT a.address, a.message, a.starts_at, a.ends_at, a.urgent, a.capacity_cap, a.lat, a.lng,
            a.verification_status, a.send_state, p.name AS provider_name, p.status AS provider_status
     FROM alerts a JOIN providers p ON p.id = a.provider_id WHERE a.id = $1`,
    [alertId],
  );
  const alert = found.rows[0];
  if (!alert || alert.verification_status !== 'verified' || alert.send_state === 'sent' || alert.send_state === 'expired') return;

  // Suspension is the kill switch: an alert queued before the suspension must not go out.
  if (alert.provider_status !== 'approved') {
    await db.query("UPDATE alerts SET send_state = 'expired' WHERE id = $1 AND send_state IN ('pending', 'sending')", [alertId]);
    return;
  }

  const failUnsent = () =>
    db.query(
      "UPDATE deliveries SET status = 'failed' WHERE alert_id = $1 AND status = 'queued' AND vonage_id IS NULL AND claimed_at IS NULL",
      [alertId],
    );

  const d = quietHoursDecision(deps.now(), alert.ends_at, alert.urgent);
  if (d.action === 'expire') {
    await db.query("UPDATE alerts SET send_state = 'expired' WHERE id = $1 AND send_state IN ('pending', 'sending')", [alertId]);
    await failUnsent();
    return;
  }
  if (d.action === 'defer') {
    await deps.enqueue(alertId, d.until);
    return;
  }

  // Claim + select + insert in one transaction: the alert is selected exactly once, ever.
  // A concurrent run blocks on the row lock, then sees 'sending' and skips straight to the send loop.
  await withTx(db, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [SELECT_LOCK]);
    const claim = await c.query(
      "UPDATE alerts SET send_state = 'sending' WHERE id = $1 AND send_state = 'pending' RETURNING id",
      [alertId],
    );
    if (!claim.rowCount) return;
    const picked = await selectRecipients(c, { lat: alert.lat, lng: alert.lng, cap: alert.capacity_cap, now: deps.now() });
    for (const r of picked) {
      await c.query(
        'INSERT INTO deliveries (alert_id, recipient_id, status) VALUES ($1, $2, $3) ON CONFLICT (alert_id, recipient_id) DO NOTHING',
        [alertId, r.id, 'queued'],
      );
    }
  });

  const unsent = await db.query(
    `SELECT d.id, d.recipient_id, r.channel, r.language, r.phone
     FROM deliveries d JOIN recipients r ON r.id = d.recipient_id
     WHERE d.alert_id = $1 AND d.status = 'queued' AND d.vonage_id IS NULL AND d.claimed_at IS NULL
     ORDER BY d.created_at, d.id`,
    [alertId],
  );
  const delayMs = Math.ceil(1000 / config.VONAGE_RATE_PER_SECOND);
  const text = (channel: 'sms' | 'voice') =>
    buildMessageText({ providerName: alert.provider_name, message: alert.message, address: alert.address, startsAt: alert.starts_at }, channel);

  for (const row of unsent.rows) {
    if (deps.now().getTime() >= alert.ends_at.getTime()) {
      await failUnsent();
      break;
    }
    // Claim and consent re-check in one statement: a STOP that lands after selection always wins.
    const claimed = await db.query(
      `UPDATE deliveries SET claimed_at = $2
       WHERE id = $1 AND claimed_at IS NULL AND vonage_id IS NULL AND status = 'queued'
         AND EXISTS (SELECT 1 FROM recipients r WHERE r.id = deliveries.recipient_id AND r.status = 'active'
           AND EXISTS (SELECT 1 FROM consents c WHERE c.recipient_id = r.id AND c.revoked_at IS NULL))
       RETURNING id`,
      [row.id, deps.now()],
    );
    if (!claimed.rowCount) {
      // Not claimable: stopped recipient (mark it) or another run owns it (no-op: the guards fail).
      await db.query(
        "UPDATE deliveries SET status = 'stopped' WHERE id = $1 AND status = 'queued' AND vonage_id IS NULL AND claimed_at IS NULL",
        [row.id],
      );
      continue;
    }

    let id: string | undefined;
    try {
      const to = decryptPhone(row.phone);
      id = (row.channel === 'voice'
        ? await sender.startCall(to, text('voice'), voiceLocale(row.language))
        : await sender.sendSms(to, text('sms'))).id;
    } catch {
      // Deliberately no error text: it could carry the number or message body.
    }
    if (id === undefined) {
      await db.query("UPDATE deliveries SET status = 'failed' WHERE id = $1 AND status = 'queued'", [row.id]);
    } else {
      // The message went out: never record it as failed. Retry the id store once, else leave the row claimed.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await db.query("UPDATE deliveries SET vonage_id = $2 WHERE id = $1 AND status = 'queued'", [row.id, id]);
          break;
        } catch { /* retry once, then continue */ }
      }
    }
    await sleep(delayMs);
  }

  await db.query("UPDATE alerts SET send_state = 'sent', sent_at = $2 WHERE id = $1 AND send_state = 'sending'", [alertId, deps.now()]);
}
