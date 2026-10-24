import type pg from 'pg';
import { withTx } from '../db.js';

export class ProviderAdminError extends Error {
  constructor(public readonly code: 'NOT_FOUND', message: string) {
    super(message);
    this.name = 'ProviderAdminError';
  }
}

async function setStatus(db: pg.Pool, adminId: string, providerId: string, status: 'approved' | 'suspended') {
  await withTx(db, async (c) => {
    const a = await c.query(`SELECT 1 FROM provider_users WHERE id = $1 AND role = 'admin'`, [adminId]);
    if (!a.rowCount) throw new Error('Actor is not an admin');
    const u = await c.query(
      `UPDATE providers SET status = $2, verified_at = CASE WHEN $2 = 'approved' THEN now() ELSE verified_at END
        WHERE id = $1`,
      [providerId, status],
    );
    if (!u.rowCount) throw new ProviderAdminError('NOT_FOUND', 'Provider not found');
    await c.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES ($1, $2, 'provider', $3)`, [
      adminId,
      status === 'approved' ? 'provider.approve' : 'provider.suspend',
      providerId,
    ]);
  });
}

export const approveProvider = (db: pg.Pool, adminId: string, providerId: string) =>
  setStatus(db, adminId, providerId, 'approved');
export const suspendProvider = (db: pg.Pool, adminId: string, providerId: string) =>
  setStatus(db, adminId, providerId, 'suspended');
