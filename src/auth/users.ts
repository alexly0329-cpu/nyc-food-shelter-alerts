import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type pg from 'pg';

export const SESSION_HOURS = 12;

export const hashPassword = (pw: string) => hash(pw);
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

let dummyHash: Promise<string> | undefined;

// Same null for unknown email and wrong password; verify runs either way to even out timing.
export async function login(db: pg.Pool, email: string, password: string): Promise<{ sessionToken: string } | null> {
  const { rows } = await db.query('SELECT id, password_hash FROM provider_users WHERE email = $1', [
    email.trim().toLowerCase(),
  ]);
  const user = rows[0];
  const ok = await verify(user?.password_hash ?? (await (dummyHash ??= hash(randomBytes(16).toString('hex')))), password).catch(
    () => false,
  );
  if (!user || !ok) return null;
  const sessionToken = randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [hashToken(sessionToken), user.id, SESSION_HOURS],
  );
  await db.query('DELETE FROM sessions WHERE expires_at < now()'); // lazy cleanup
  return { sessionToken };
}
