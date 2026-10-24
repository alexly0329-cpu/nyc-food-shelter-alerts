import type pg from 'pg';
import { hashToken } from './users.js';

export class AuthError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message);
  }
}

async function sessionUser(db: pg.Pool, token: string | undefined) {
  if (!token) throw new AuthError(401, 'Not signed in');
  const { rows } = await db.query(
    `SELECT u.id, u.role, u.provider_id, p.status
       FROM sessions s
       JOIN provider_users u ON u.id = s.user_id
       LEFT JOIN providers p ON p.id = u.provider_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (!rows[0]) throw new AuthError(401, 'Invalid or expired session');
  return rows[0] as { id: string; role: string; provider_id: string | null; status: string | null };
}

export async function requireProvider(db: pg.Pool, token: string | undefined) {
  const u = await sessionUser(db, token);
  if (u.role !== 'staff' || !u.provider_id) throw new AuthError(403, 'Provider staff only');
  if (u.status !== 'approved') throw new AuthError(403, `Provider is ${u.status}`);
  return { userId: u.id, providerId: u.provider_id };
}

export async function requireAdmin(db: pg.Pool, token: string | undefined) {
  const u = await sessionUser(db, token);
  if (u.role !== 'admin') throw new AuthError(403, 'Admin only');
  return { userId: u.id };
}
