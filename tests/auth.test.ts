import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../src/db.js';
import { applyProvider } from '../src/providers/apply.js';
import { approveProvider, suspendProvider } from '../src/providers/admin.js';
import { hashPassword, login } from '../src/auth/users.js';
import { AuthError, requireAdmin, requireProvider } from '../src/auth/session.js';

const pool = getPool();
const input = {
  name: 'Food Pantry', address: '1 Main St', contactName: 'Pat', phone: '212-555-0123',
  email: 'pat@example.org', password: 'correct horse battery',
};

async function makeAdmin() {
  const r = await pool.query(
    `INSERT INTO provider_users (email, password_hash, role) VALUES ('admin@example.org', $1, 'admin') RETURNING id`,
    [await hashPassword('admin-password-1')],
  );
  return r.rows[0].id as string;
}

async function status(p: Promise<unknown>) {
  try { await p; return 200; } catch (e) { if (e instanceof AuthError) return e.status; throw e; }
}

beforeEach(async () => {
  await pool.query('TRUNCATE providers, provider_users, sessions, audit_log CASCADE');
});
afterAll(() => pool.end());

describe('login', () => {
  it('returns a hex token and stores only its hash', async () => {
    await applyProvider(pool, input);
    const r = await login(pool, 'PAT@example.org', input.password);
    expect(r!.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    const s = await pool.query('SELECT token_hash FROM sessions');
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].token_hash).not.toBe(r!.sessionToken);
  });

  it('returns null for wrong password and unknown email', async () => {
    await applyProvider(pool, input);
    expect(await login(pool, input.email, 'wrong-password-123')).toBeNull();
    expect(await login(pool, 'who@example.org', input.password)).toBeNull();
  });
});

describe('requireProvider', () => {
  it('401 without, invalid or expired token', async () => {
    const { providerId } = await applyProvider(pool, input);
    const adminId = await makeAdmin();
    await approveProvider(pool, adminId, providerId);
    const { sessionToken } = (await login(pool, input.email, input.password))!;
    expect(await status(requireProvider(pool, undefined))).toBe(401);
    expect(await status(requireProvider(pool, 'deadbeef'))).toBe(401);
    expect(await status(requireProvider(pool, sessionToken))).toBe(200);
    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);
    expect(await status(requireProvider(pool, sessionToken))).toBe(401);
  });

  it('pending 403, approved ok, suspended 403', async () => {
    const { providerId } = await applyProvider(pool, input);
    const adminId = await makeAdmin();
    const { sessionToken } = (await login(pool, input.email, input.password))!;
    expect(await status(requireProvider(pool, sessionToken))).toBe(403);
    await approveProvider(pool, adminId, providerId);
    const ok = await requireProvider(pool, sessionToken);
    expect(ok.providerId).toBe(providerId);
    expect(ok.userId).toBeTruthy();
    await suspendProvider(pool, adminId, providerId);
    expect(await status(requireProvider(pool, sessionToken))).toBe(403);
  });

  it('rejects admin sessions with 403', async () => {
    await makeAdmin();
    const { sessionToken } = (await login(pool, 'admin@example.org', 'admin-password-1'))!;
    expect(await status(requireProvider(pool, sessionToken))).toBe(403);
  });
});

describe('requireAdmin', () => {
  it('accepts admin, rejects staff with 403 and missing token with 401', async () => {
    const adminId = await makeAdmin();
    await applyProvider(pool, input);
    const a = (await login(pool, 'admin@example.org', 'admin-password-1'))!;
    const s = (await login(pool, input.email, input.password))!;
    expect(await requireAdmin(pool, a.sessionToken)).toEqual({ userId: adminId });
    expect(await status(requireAdmin(pool, s.sessionToken))).toBe(403);
    expect(await status(requireAdmin(pool, undefined))).toBe(401);
  });
});
