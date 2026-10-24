import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type pg from 'pg';

export const SESSION_HOURS = 12;
export const MAX_PASSWORD = 256; // bounds argon2 work per request

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const hashPassword = (pw: string) => hash(pw);
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

let dummyHash: Promise<string> | undefined;

// Same null for unknown email and wrong password; verify runs either way to even out timing.
export async function login(db: pg.Pool, email: string, password: string): Promise<{ sessionToken: string } | null> {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD) return null;
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

/** First-admin bootstrap. Never overwrites an existing user; errors never contain the password. */
export async function createAdmin(db: pg.Pool, email: string, password: string): Promise<{ id: string }> {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(e)) throw new Error('email is invalid');
  if (typeof password !== 'string' || password.length < 10 || password.length > MAX_PASSWORD) {
    throw new Error(`password must be 10 to ${MAX_PASSWORD} characters`);
  }
  try {
    const r = await db.query(`INSERT INTO provider_users (email, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id`, [
      e,
      await hashPassword(password),
    ]);
    return { id: r.rows[0].id as string };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new Error(`A user with email ${e} already exists; nothing was changed`);
    throw err;
  }
}
