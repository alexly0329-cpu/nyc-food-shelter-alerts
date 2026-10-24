import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../src/db.js';
import { phoneHash } from '../src/crypto.js';
import { CONSENT_SCRIPT_VERSION, EnrollError, enrollRecipient } from '../src/recipients/enroll.js';
import { revokeConsent } from '../src/recipients/revoke.js';

const pool = getPool();
let providerId: string;
const input = () => ({
  providerId, phone: '(718) 555-0142', channel: 'sms' as const, language: 'en', zip: '11201',
  method: 'verbal' as const, scriptConfirmed: true,
});
const count = async (t: string) => (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n as number;
const code = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof EnrollError ? e.code : e));

beforeEach(async () => {
  await pool.query('TRUNCATE recipients, consents, providers CASCADE');
  const r = await pool.query(
    `INSERT INTO providers (name, address, contact, status) VALUES ('Pantry', '1 Main St', 'Pat', 'approved') RETURNING id`,
  );
  providerId = r.rows[0].id;
});
afterAll(() => pool.end());

describe('enrollRecipient', () => {
  it('inserts one recipient and one consent with the script version', async () => {
    const { recipientId } = await enrollRecipient(pool, input());
    const r = await pool.query('SELECT * FROM recipients WHERE id = $1', [recipientId]);
    expect(r.rows[0]).toMatchObject({ zip: '11201', status: 'active', channel: 'sms', enrolled_by_provider_id: providerId });
    expect(typeof r.rows[0].lat).toBe('number');
    const c = await pool.query('SELECT * FROM consents WHERE recipient_id = $1', [recipientId]);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0]).toMatchObject({ consent_text_version: CONSENT_SCRIPT_VERSION, method: 'verbal', revoked_at: null });
    expect(CONSENT_SCRIPT_VERSION).toBe('v1-draft');
  });

  it('stores the phone encrypted, not plain', async () => {
    const { recipientId } = await enrollRecipient(pool, input());
    const r = await pool.query('SELECT phone, phone_hash FROM recipients WHERE id = $1', [recipientId]);
    expect(r.rows[0].phone.toString('utf8')).not.toContain('7185550142');
    expect(r.rows[0].phone_hash).toBe(phoneHash('+17185550142'));
  });

  it('rejects unconfirmed script and inserts nothing', async () => {
    expect(await code(enrollRecipient(pool, { ...input(), scriptConfirmed: false }))).toBe('SCRIPT_NOT_CONFIRMED');
    expect(await count('recipients')).toBe(0);
    expect(await count('consents')).toBe(0);
  });

  it('rejects ZIPs outside NYC or unknown with a clear message', async () => {
    for (const zip of ['90210', '00000', 'abcde', '']) {
      expect(await code(enrollRecipient(pool, { ...input(), zip }))).toBe('ZIP_NOT_NYC');
    }
    await expect(enrollRecipient(pool, { ...input(), zip: '90210' })).rejects.toThrow(/NYC/);
    expect(await count('recipients')).toBe(0);
  });

  it('rejects bad phones, channel and method', async () => {
    expect(await code(enrollRecipient(pool, { ...input(), phone: '718-CALL-NOW' }))).toBe('INVALID_PHONE');
    expect(await code(enrollRecipient(pool, { ...input(), phone: '(718) 055-0142' }))).toBe('INVALID_PHONE');
    expect(await code(enrollRecipient(pool, { ...input(), channel: 'fax' as never }))).toBe('INVALID_INPUT');
    expect(await code(enrollRecipient(pool, { ...input(), method: 'telepathy' as never }))).toBe('INVALID_INPUT');
  });

  it('reuses the recipient on re-enrollment and adds a consent row', async () => {
    const a = await enrollRecipient(pool, input());
    const b = await enrollRecipient(pool, { ...input(), phone: '+17185550142' });
    expect(b.recipientId).toBe(a.recipientId);
    expect(await count('recipients')).toBe(1);
    expect(await count('consents')).toBe(2);
  });

  it('handles concurrent enrollments of one number', async () => {
    const rs = await Promise.all([1, 2, 3].map(() => enrollRecipient(pool, input())));
    expect(new Set(rs.map((r) => r.recipientId)).size).toBe(1);
    expect(await count('recipients')).toBe(1);
    expect(await count('consents')).toBe(3);
  });

  it('keeps the first enrolling provider on re-enrollment', async () => {
    const p2 = (await pool.query(
      `INSERT INTO providers (name, address, contact, status) VALUES ('Other', '2 Main St', 'Sam', 'approved') RETURNING id`,
    )).rows[0].id;
    const a = await enrollRecipient(pool, input());
    await enrollRecipient(pool, { ...input(), providerId: p2 });
    const r = await pool.query('SELECT enrolled_by_provider_id FROM recipients WHERE id = $1', [a.recipientId]);
    expect(r.rows[0].enrolled_by_provider_id).toBe(providerId);
  });

  it('updates channel, language, zip and location on re-enrollment but not the enrolling provider', async () => {
    const p2 = (await pool.query(
      `INSERT INTO providers (name, address, contact, status) VALUES ('Other', '2 Main St', 'Sam', 'approved') RETURNING id`,
    )).rows[0].id;
    const a = await enrollRecipient(pool, input());
    const before = (await pool.query('SELECT * FROM recipients WHERE id = $1', [a.recipientId])).rows[0];
    await enrollRecipient(pool, { ...input(), providerId: p2, zip: '10451', channel: 'voice', language: 'es' });
    const after = (await pool.query('SELECT * FROM recipients WHERE id = $1', [a.recipientId])).rows[0];
    expect(after).toMatchObject({ channel: 'voice', language: 'es', zip: '10451', enrolled_by_provider_id: providerId });
    expect(after.lat).not.toBe(before.lat);
    expect(after.lng).not.toBe(before.lng);
  });

  it('reactivates a stopped recipient with a new consent; old revoked rows stay revoked', async () => {
    const a = await enrollRecipient(pool, input());
    await revokeConsent(pool, '+17185550142');
    await enrollRecipient(pool, input());
    const r = await pool.query('SELECT status FROM recipients WHERE id = $1', [a.recipientId]);
    expect(r.rows[0].status).toBe('active');
    const c = await pool.query('SELECT revoked_at FROM consents WHERE recipient_id = $1 ORDER BY created_at', [a.recipientId]);
    expect(c.rows).toHaveLength(2);
    expect(c.rows[0].revoked_at).not.toBeNull();
    expect(c.rows[1].revoked_at).toBeNull();
  });
});

describe('revokeConsent', () => {
  it('revokes all consents and stops the recipient; safe to repeat', async () => {
    const a = await enrollRecipient(pool, input());
    await enrollRecipient(pool, input());
    expect(await revokeConsent(pool, '+17185550142')).toBe(true);
    const first = await pool.query('SELECT revoked_at FROM consents WHERE recipient_id = $1', [a.recipientId]);
    expect(first.rows.every((x) => x.revoked_at !== null)).toBe(true);
    expect((await pool.query('SELECT status FROM recipients WHERE id = $1', [a.recipientId])).rows[0].status).toBe('stopped');
    expect(await revokeConsent(pool, '+17185550142')).toBe(true);
    const second = await pool.query('SELECT revoked_at FROM consents WHERE recipient_id = $1', [a.recipientId]);
    expect(second.rows.map((x) => +x.revoked_at).sort()).toEqual(first.rows.map((x) => +x.revoked_at).sort());
  });

  it('returns false for an unknown number', async () => {
    expect(await revokeConsent(pool, '+12125550199')).toBe(false);
  });
});
