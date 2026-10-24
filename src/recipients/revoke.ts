import type pg from 'pg';
import { phoneHash } from '../crypto.js';
import { withTx } from '../db.js';
import { logEvent } from '../ops/log.js';

/**
 * STOP: revoke every active consent and stop the recipient. Returns false if the number is unknown.
 * With actorUserId (staff/admin opt-out) a `recipient.optout` audit row is written in the same transaction (ids only).
 */
export async function revokeConsent(db: pg.Pool, phoneE164: string, actorUserId?: string): Promise<boolean> {
  return withTx(db, async (c) => {
    const r = await c.query(`UPDATE recipients SET status = 'stopped' WHERE phone_hash = $1 RETURNING id`, [phoneHash(phoneE164)]);
    if (!r.rowCount) return false;
    await c.query('UPDATE consents SET revoked_at = now() WHERE recipient_id = $1 AND revoked_at IS NULL', [r.rows[0].id]);
    if (actorUserId) {
      await c.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES ($1, 'recipient.optout', 'recipient', $2)`, [actorUserId, r.rows[0].id]);
    }
    return true;
  });
}

/** The one stop path for the inbound webhook and the staff/admin routes. A failed revoke propagates; a failed delivery mark does not. */
export async function stopRecipient(db: pg.Pool, phoneE164: string, actorUserId?: string): Promise<boolean> {
  if (!(await revokeConsent(db, phoneE164, actorUserId))) return false;
  try {
    // Only the newest delivery: older ones are history.
    await db.query(
      `UPDATE deliveries SET status = 'stopped'
       WHERE id = (SELECT d.id FROM deliveries d JOIN recipients r ON r.id = d.recipient_id
                   WHERE r.phone_hash = $1 ORDER BY d.created_at DESC LIMIT 1)
         AND status IN ('queued', 'delivered')`,
      [phoneHash(phoneE164)],
    );
  } catch {
    logEvent('webhook_error', { route: 'stop', reason: 'delivery_update_failed' });
  }
  return true;
}
