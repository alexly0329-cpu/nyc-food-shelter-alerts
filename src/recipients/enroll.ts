import type pg from 'pg';
import { encryptPhone, phoneHash } from '../crypto.js';
import { withTx } from '../db.js';
import { zipToCentroid } from '../geo/geo.js';
import { normalizePhone } from '../phone.js';

export const CONSENT_SCRIPT_VERSION = 'v2-draft';

/** Stored in recipients.language; the UI offers exactly these (names and codes are both accepted). */
export const LANGUAGES = ['English', 'Español', '中文', 'Русский', 'বাংলা', 'Kreyòl ayisyen', 'en', 'es', 'zh', 'ru'] as const;

export type EnrollErrorCode = 'SCRIPT_NOT_CONFIRMED' | 'INVALID_PHONE' | 'ZIP_NOT_NYC' | 'INVALID_INPUT';

export class EnrollError extends Error {
  constructor(public code: EnrollErrorCode, message: string) {
    super(message);
    this.name = 'EnrollError';
  }
}

export type EnrollInput = {
  providerId: string;
  /** The signed-in staff user; recorded in audit_log. */
  actorUserId: string;
  phone: string;
  channel: 'sms' | 'voice';
  language: string;
  zip: string;
  method: 'verbal' | 'written';
  scriptConfirmed: boolean;
};

export async function enrollRecipient(db: pg.Pool, input: EnrollInput): Promise<{ recipientId: string }> {
  if (input.scriptConfirmed !== true) {
    throw new EnrollError('SCRIPT_NOT_CONFIRMED', 'The consent script must be read and confirmed before enrolling');
  }
  const phone = normalizePhone(input.phone);
  if (!phone) throw new EnrollError('INVALID_PHONE', 'Phone is not a valid US number');
  const point = zipToCentroid(input.zip);
  if (!point) throw new EnrollError('ZIP_NOT_NYC', 'ZIP code is not a recognized NYC ZIP code');
  if (!(LANGUAGES as readonly string[]).includes(input.language)) throw new EnrollError('INVALID_INPUT', 'Language is not supported');
  if (input.channel !== 'sms' && input.channel !== 'voice') throw new EnrollError('INVALID_INPUT', 'Channel must be sms or voice');
  if (input.method !== 'verbal' && input.method !== 'written') throw new EnrollError('INVALID_INPUT', 'Method must be verbal or written');

  return withTx(db, async (c) => {
    // Lock the existing row so the audit action reflects the status we actually replace.
    const prev = await c.query('SELECT status FROM recipients WHERE phone_hash = $1 FOR UPDATE', [phoneHash(phone)]);
    const wasStopped = prev.rows[0]?.status === 'stopped';
    // Upsert on phone_hash: concurrent enrollments of one number converge on one row.
    const r = await c.query(
      `INSERT INTO recipients (phone, phone_hash, channel, language, zip, lat, lng, enrolled_by_provider_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (phone_hash) DO UPDATE SET status = 'active', channel = EXCLUDED.channel, language = EXCLUDED.language,
         zip = EXCLUDED.zip, lat = EXCLUDED.lat, lng = EXCLUDED.lng
       RETURNING id`,
      [encryptPhone(phone), phoneHash(phone), input.channel, input.language, input.zip, point.lat, point.lng, input.providerId],
    );
    const recipientId = r.rows[0].id as string;
    await c.query(
      `INSERT INTO consents (recipient_id, provider_id, method, consent_text_version) VALUES ($1, $2, $3, $4)`,
      [recipientId, input.providerId, input.method, CONSENT_SCRIPT_VERSION],
    );
    await c.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES ($1, $2, 'recipient', $3)`, [
      input.actorUserId,
      wasStopped ? 'recipient.reenroll_after_stop' : 'recipient.enroll',
      recipientId,
    ]);
    return { recipientId };
  });
}
