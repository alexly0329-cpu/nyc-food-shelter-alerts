import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSafeTestDb, parseHashKey } from '../src/config.js';
import { getPool, migrate } from '../src/db.js';

const pool = getPool();

async function seedConsent() {
  const p = await pool.query(`INSERT INTO providers (name, address, contact) VALUES ('P','1 Main','c') RETURNING id`);
  const r = await pool.query(
    `INSERT INTO recipients (phone, phone_hash, channel, zip, lat, lng, enrolled_by_provider_id)
     VALUES ('\\x00', 'h', 'sms', '10001', 40.75, -73.99, $1) RETURNING id`,
    [p.rows[0].id],
  );
  const c = await pool.query(
    `INSERT INTO consents (recipient_id, provider_id, method, consent_text_version)
     VALUES ($1, $2, 'verbal', 'v1') RETURNING id`,
    [r.rows[0].id, p.rows[0].id],
  );
  return c.rows[0].id as string;
}

beforeEach(async () => {
  await pool.query('TRUNCATE providers, provider_users, recipients, consents, alerts, deliveries CASCADE');
});
afterAll(() => pool.end());

describe('schema', () => {
  it('migrate creates all tables', async () => {
    await migrate(pool); // idempotent
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'alerts', 'audit_log', 'consents', 'deliveries', 'provider_users', 'providers', 'recipients', 'schema_migrations', 'sessions',
    ]);
  });

  it('consents rejects DELETE', async () => {
    const id = await seedConsent();
    await expect(pool.query('DELETE FROM consents WHERE id = $1', [id])).rejects.toThrow(/append-only/);
  });

  it('consents rejects UPDATE of method', async () => {
    const id = await seedConsent();
    await expect(pool.query(`UPDATE consents SET method = 'written' WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
  });

  it('consents allows setting revoked_at', async () => {
    const id = await seedConsent();
    await pool.query('UPDATE consents SET revoked_at = now() WHERE id = $1', [id]);
    const { rows } = await pool.query('SELECT revoked_at FROM consents WHERE id = $1', [id]);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it('consents rejects revoked_at set together with another column', async () => {
    const id = await seedConsent();
    await expect(
      pool.query(`UPDATE consents SET revoked_at = now(), method = 'written' WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
  });

  it('consents rejects clearing or changing an already-set revoked_at', async () => {
    const id = await seedConsent();
    await pool.query('UPDATE consents SET revoked_at = now() WHERE id = $1', [id]);
    await expect(pool.query('UPDATE consents SET revoked_at = NULL WHERE id = $1', [id])).rejects.toThrow(/revoked_at/);
    await expect(
      pool.query(`UPDATE consents SET revoked_at = now() + interval '1 day' WHERE id = $1`, [id]),
    ).rejects.toThrow(/revoked_at/);
  });
});

describe('assertSafeTestDb', () => {
  it('accepts local _test databases', () => {
    expect(() => assertSafeTestDb('postgres://u:p@localhost:5433/alerts_test')).not.toThrow();
    expect(() => assertSafeTestDb('postgres://u:p@127.0.0.1/x_test')).not.toThrow();
  });
  it('rejects remote hosts and non-_test names', () => {
    expect(() => assertSafeTestDb('postgres://u:p@db.prod.example.com/alerts_test')).toThrow(/Refusing/);
    expect(() => assertSafeTestDb('postgres://u:p@localhost/alerts')).toThrow(/Refusing/);
    expect(() => assertSafeTestDb('postgres://u:p@localhost.evil.com/alerts_test')).toThrow(/Refusing/);
  });
  it('rejects host= and hostaddr= query parameters that override the host', () => {
    expect(() => assertSafeTestDb('postgres://u:p@localhost/alerts_test?host=db.prod.example.com')).toThrow(/Refusing/);
    expect(() => assertSafeTestDb('postgres://u:p@localhost/alerts_test?hostaddr=10.0.0.5')).toThrow(/Refusing/);
    expect(() => assertSafeTestDb('postgres://u:p@localhost/alerts_test?sslmode=disable&HOST=x')).toThrow(/Refusing/);
  });
});

describe('pool error handler', () => {
  it('an idle-client error is logged as queue_error/db_pool_error without its text and does not throw', () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as never);
    try {
      expect(() => pool.emit('error', new Error('conn to 10.1.2.3 as secretuser'))).not.toThrow();
    } finally { spy.mockRestore(); }
    expect(out.map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ event: 'queue_error', reason: 'db_pool_error' })]);
    expect(out.join('')).not.toContain('secretuser');
  });
});

describe('parseHashKey', () => {
  it('accepts 32 bytes, rejects shorter, and never echoes the value', () => {
    const ok = Buffer.alloc(32, 9).toString('base64');
    expect(parseHashKey(ok)).toBe(ok);
    const short = Buffer.alloc(16, 9).toString('base64');
    expect(() => parseHashKey(short)).toThrow(/PHONE_HASH_KEY must decode to at least 32 bytes/);
    try { parseHashKey(short); } catch (e) { expect((e as Error).message).not.toContain(short); }
    expect(() => parseHashKey('!!')).toThrow(/PHONE_HASH_KEY/);
  });
});
