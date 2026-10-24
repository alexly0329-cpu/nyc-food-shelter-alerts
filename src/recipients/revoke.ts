import type pg from 'pg';
import { phoneHash } from '../crypto.js';
import { withTx } from '../db.js';

/** STOP: revoke every active consent and stop the recipient. Returns false if the number is unknown. */
export async function revokeConsent(db: pg.Pool, phoneE164: string): Promise<boolean> {
  return withTx(db, async (c) => {
    const r = await c.query(`UPDATE recipients SET status = 'stopped' WHERE phone_hash = $1 RETURNING id`, [phoneHash(phoneE164)]);
    if (!r.rowCount) return false;
    await c.query('UPDATE consents SET revoked_at = now() WHERE recipient_id = $1 AND revoked_at IS NULL', [r.rows[0].id]);
    return true;
  });
}
