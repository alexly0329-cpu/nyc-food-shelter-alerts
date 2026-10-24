import type pg from 'pg';

let n = 0;
/** Creates a user to act as `actorUserId` (audit_log has a foreign key to provider_users). Call after any TRUNCATE. */
export async function mkActor(pool: pg.Pool): Promise<string> {
  const r = await pool.query(
    `INSERT INTO provider_users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`,
    [`actor${n++}-${Math.random().toString(36).slice(2)}@example.test`],
  );
  return r.rows[0].id as string;
}
