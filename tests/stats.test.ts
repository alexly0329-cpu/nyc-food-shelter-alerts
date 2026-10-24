import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { alertTotals } from '../src/alerts/stats.js';
import { getPool } from '../src/db.js';
import { enrollRecipient } from '../src/recipients/enroll.js';

const pool = getPool();
let seq = 0;

const mkProvider = async (name: string) =>
  (await pool.query(`INSERT INTO providers (name, address, contact, status) VALUES ($1, '1 Main St', 'c', 'approved') RETURNING id`, [name])).rows[0].id as string;
const mkAlert = async (pid: string, message: string, ageMin: number) =>
  (await pool.query(
    `INSERT INTO alerts (provider_id, service_type, address, lat, lng, message, starts_at, ends_at, capacity_cap, idempotency_key, verification_status, created_at)
     VALUES ($1, 'food', '1 Main St', 40.7, -74, $2, now(), now() + interval '1 hour', 10, $3, 'verified', now() - ($4 || ' minutes')::interval) RETURNING id`,
    [pid, message, `k${seq++}`, String(ageMin)],
  )).rows[0].id as string;
const mkDelivery = async (alertId: string, pid: string, status: string, o: { vonage?: string | null; claimed?: boolean } = {}) => {
  const { recipientId } = await enrollRecipient(pool, {
    providerId: pid, phone: `(718) 555-${String(100 + seq++).padStart(4, '0')}`, channel: 'sms', language: 'en', zip: '11201', method: 'verbal', scriptConfirmed: true,
  });
  await pool.query(
    `INSERT INTO deliveries (alert_id, recipient_id, status, vonage_id, claimed_at) VALUES ($1, $2, $3, $4, $5)`,
    [alertId, recipientId, status, o.vonage ?? null, o.claimed ? new Date() : null],
  );
};

beforeEach(async () => {
  await pool.query('TRUNCATE deliveries, alerts, consents, recipients, provider_users, providers CASCADE');
});
afterAll(() => pool.end());

describe('alertTotals', () => {
  it('counts per status, newest first, scoped to provider, no recipient data', async () => {
    const a = await mkProvider('A');
    const b = await mkProvider('B');
    const old = await mkAlert(a, 'old', 60);
    const recent = await mkAlert(a, 'recent', 1);
    const other = await mkAlert(b, 'other', 5);
    await mkDelivery(recent, a, 'delivered', { vonage: 'v1' });
    await mkDelivery(recent, a, 'delivered', { vonage: 'v2' });
    await mkDelivery(recent, a, 'failed', { claimed: true }); // attempted, send errored
    await mkDelivery(recent, a, 'stopped', { vonage: 'v3' });
    await mkDelivery(recent, a, 'queued', { claimed: true }); // outcome unknown: still texted
    await mkDelivery(recent, a, 'queued'); // selected, never attempted: not texted
    await mkDelivery(recent, a, 'failed'); // failed on expiry without an attempt: not texted
    await mkDelivery(recent, a, 'stopped'); // stopped before sending: not texted
    await mkDelivery(other, b, 'delivered', { vonage: 'v4' });

    const rows = await alertTotals(pool, a);
    expect(rows.map((r) => r.alertId)).toEqual([recent, old]);
    expect(rows[0]).toMatchObject({ title: 'recent', status: 'pending', verification: 'verified', capacityCap: 10, texted: 5, delivered: 2, failed: 2, stopped: 2 });
    expect(rows[1]).toMatchObject({ texted: 0, delivered: 0, failed: 0, stopped: 0 });
    expect(rows[0].startsAt).toBeInstanceOf(Date);
    expect(rows.map((r) => r.alertId)).not.toContain(other);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['address', 'alertId', 'capacityCap', 'delivered', 'endsAt', 'failed', 'serviceType', 'startsAt', 'status', 'stopped', 'texted', 'title', 'verification'],
    );
  });
});
