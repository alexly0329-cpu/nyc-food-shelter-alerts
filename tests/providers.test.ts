import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../src/db.js';
import { applyProvider } from '../src/providers/apply.js';
import { approveProvider, suspendProvider } from '../src/providers/admin.js';
import { hashPassword } from '../src/auth/users.js';

const pool = getPool();
const input = {
  name: 'Food Pantry', address: '1 Main St', contactName: 'Pat', phone: '(212) 555-0123',
  email: 'pat@example.org', password: 'correct horse battery',
};

async function makeAdmin() {
  const r = await pool.query(
    `INSERT INTO provider_users (email, password_hash, role) VALUES ('admin@example.org', $1, 'admin') RETURNING id`,
    [await hashPassword('admin-password-1')],
  );
  return r.rows[0].id as string;
}

beforeEach(async () => {
  await pool.query('TRUNCATE providers, provider_users, sessions, audit_log CASCADE');
});
afterAll(() => pool.end());

describe('applyProvider', () => {
  it('creates a pending provider with one staff user and hashed password', async () => {
    const { providerId } = await applyProvider(pool, input);
    const p = await pool.query('SELECT status FROM providers WHERE id = $1', [providerId]);
    expect(p.rows[0].status).toBe('pending');
    const u = await pool.query('SELECT role, password_hash FROM provider_users WHERE provider_id = $1', [providerId]);
    expect(u.rows).toHaveLength(1);
    expect(u.rows[0].role).toBe('staff');
    expect(u.rows[0].password_hash).toMatch(/^\$argon2/);
    expect(u.rows[0].password_hash).not.toContain(input.password);
  });

  it('rejects duplicate email with a clear error and leaves no orphan provider', async () => {
    await applyProvider(pool, input);
    await expect(applyProvider(pool, { ...input, email: 'PAT@example.org' })).rejects.toThrow(/already registered/);
    expect((await pool.query('SELECT count(*)::int AS n FROM providers')).rows[0].n).toBe(1);
  });

  it('validates input', async () => {
    await expect(applyProvider(pool, { ...input, name: ' ' })).rejects.toThrow(/name/);
    await expect(applyProvider(pool, { ...input, email: 'nope' })).rejects.toThrow(/email/);
    await expect(applyProvider(pool, { ...input, phone: '123' })).rejects.toThrow(/phone/);
    await expect(applyProvider(pool, { ...input, password: 'short' })).rejects.toThrow(/password/);
  });
});

describe('approve / suspend', () => {
  it('sets status, verified_at and audit rows', async () => {
    const adminId = await makeAdmin();
    const { providerId } = await applyProvider(pool, input);
    await approveProvider(pool, adminId, providerId);
    let p = (await pool.query('SELECT status, verified_at FROM providers WHERE id = $1', [providerId])).rows[0];
    expect(p.status).toBe('approved');
    expect(p.verified_at).not.toBeNull();
    await suspendProvider(pool, adminId, providerId);
    p = (await pool.query('SELECT status FROM providers WHERE id = $1', [providerId])).rows[0];
    expect(p.status).toBe('suspended');
    await approveProvider(pool, adminId, providerId); // re-approve allowed
    const a = await pool.query('SELECT action, target_type, target_id, actor_id FROM audit_log ORDER BY created_at, action');
    expect(a.rows.map((r) => r.action).sort()).toEqual(['provider.approve', 'provider.approve', 'provider.suspend']);
    expect(a.rows[0]).toMatchObject({ target_type: 'provider', target_id: providerId, actor_id: adminId });
  });

  it('rejects non-admin actor and unknown provider', async () => {
    const adminId = await makeAdmin();
    const { providerId } = await applyProvider(pool, input);
    const staffId = (await pool.query('SELECT id FROM provider_users WHERE provider_id = $1', [providerId])).rows[0].id;
    await expect(approveProvider(pool, staffId, providerId)).rejects.toThrow(/admin/);
    await expect(suspendProvider(pool, staffId, providerId)).rejects.toThrow(/admin/);
    await expect(approveProvider(pool, adminId, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/);
    expect((await pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(0);
  });
});
