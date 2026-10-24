import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../src/db.js';
import { encryptPhone, phoneHash } from '../src/crypto.js';
import { distanceKm } from '../src/geo/geo.js';
import { selectRecipients } from '../src/alerts/select.js';

const pool = getPool();
const NOW = new Date('2026-06-01T12:00:00Z');
const HOUR = 3_600_000;
const ORIGIN = { lat: 40.7, lng: -74.0 };
let providerId: string;
let alertId: string;
let seq = 0;

async function addRecipient(lat: number, lng: number, o: { status?: string; consent?: 'active' | 'revoked' | 'none' } = {}) {
  const phone = `+1718555${String(1000 + seq++)}`;
  const r = await pool.query(
    `INSERT INTO recipients (phone, phone_hash, channel, language, zip, lat, lng, status, enrolled_by_provider_id)
     VALUES ($1, $2, 'sms', 'es', '11201', $3, $4, $5, $6) RETURNING id`,
    [encryptPhone(phone), phoneHash(phone), lat, lng, o.status ?? 'active', providerId],
  );
  const id = r.rows[0].id as string;
  const consent = o.consent ?? 'active';
  if (consent !== 'none') {
    await pool.query(
      `INSERT INTO consents (recipient_id, provider_id, method, consent_text_version, revoked_at)
       VALUES ($1, $2, 'verbal', 'v1-draft', $3)`,
      [id, providerId, consent === 'revoked' ? NOW : null],
    );
  }
  return { id, phone };
}

const addDelivery = (recipientId: string, createdAt: Date) =>
  pool.query('INSERT INTO deliveries (alert_id, recipient_id, created_at) VALUES ($1, $2, $3)', [alertId, recipientId, createdAt]);
const select = (cap: number) => selectRecipients(pool, { ...ORIGIN, cap, now: NOW });

beforeEach(async () => {
  await pool.query('TRUNCATE deliveries, alerts, consents, recipients, providers CASCADE');
  providerId = (await pool.query(
    `INSERT INTO providers (name, address, contact, status) VALUES ('Pantry', '1 Main St', 'Pat', 'approved') RETURNING id`,
  )).rows[0].id;
  alertId = (await pool.query(
    `INSERT INTO alerts (provider_id, service_type, address, lat, lng, message, starts_at, ends_at, capacity_cap, idempotency_key)
     VALUES ($1, 'food', '1 Main St', 40.7, -74.0, 'm', $2, $3, 10, 'k') RETURNING id`,
    [providerId, NOW, new Date(NOW.getTime() + HOUR)],
  )).rows[0].id;
  seq = 0;
});
afterAll(() => pool.end());

describe('selectRecipients', () => {
  it('returns nearest first and decrypted phone, channel, language', async () => {
    const far = await addRecipient(40.9, -74.0);
    const near = await addRecipient(40.71, -74.0);
    const mid = await addRecipient(40.8, -74.0);
    const out = await select(10);
    expect(out.map((r) => r.id)).toEqual([near.id, mid.id, far.id]);
    expect(out[0]).toEqual({ id: near.id, channel: 'sms', language: 'es', phone: near.phone });
  });

  it('matches ordering by distanceKm from geo.ts', async () => {
    const pts = [[40.6, -73.9], [40.75, -74.1], [40.5, -74.2], [40.72, -73.99], [40.9, -73.8]];
    const made = await Promise.all(pts.map(([la, ln]) => addRecipient(la, ln)));
    const expected = pts
      .map((p, i) => ({ id: made[i].id, d: distanceKm(ORIGIN, { lat: p[0], lng: p[1] }) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.id);
    expect((await select(10)).map((r) => r.id)).toEqual(expected);
  });

  it('breaks distance ties by recipient id', async () => {
    const a = await addRecipient(40.8, -74.0);
    const b = await addRecipient(40.8, -74.0);
    expect((await select(10)).map((r) => r.id)).toEqual([a.id, b.id].sort());
  });

  it('stops at cap', async () => {
    const rs = [await addRecipient(40.71, -74), await addRecipient(40.72, -74), await addRecipient(40.73, -74)];
    expect((await select(2)).map((r) => r.id)).toEqual([rs[0].id, rs[1].id]);
  });

  it('excludes stopped recipients', async () => {
    await addRecipient(40.71, -74, { status: 'stopped' });
    const ok = await addRecipient(40.72, -74);
    expect((await select(10)).map((r) => r.id)).toEqual([ok.id]);
  });

  it('excludes revoked-only and no-consent recipients; any unrevoked consent suffices', async () => {
    await addRecipient(40.71, -74, { consent: 'revoked' });
    await addRecipient(40.72, -74, { consent: 'none' });
    const both = await addRecipient(40.73, -74, { consent: 'revoked' });
    await pool.query(
      `INSERT INTO consents (recipient_id, provider_id, method, consent_text_version) VALUES ($1, $2, 'written', 'v1-draft')`,
      [both.id, providerId],
    );
    expect((await select(10)).map((r) => r.id)).toEqual([both.id]);
  });

  it('excludes delivery 23h before now, includes 25h before now', async () => {
    const recent = await addRecipient(40.71, -74);
    const old = await addRecipient(40.72, -74);
    await addDelivery(recent.id, new Date(NOW.getTime() - 23 * HOUR));
    await addDelivery(old.id, new Date(NOW.getTime() - 25 * HOUR));
    expect((await select(10)).map((r) => r.id)).toEqual([old.id]);
  });

  it('returns all when fewer eligible than cap, [] when none', async () => {
    expect(await select(5)).toEqual([]);
    const a = await addRecipient(40.71, -74);
    expect((await select(5)).map((r) => r.id)).toEqual([a.id]);
  });

  it('rejects bad cap, lat, lng', async () => {
    for (const cap of [0, -1, 1.5, NaN]) await expect(select(cap)).rejects.toThrow(/cap/);
    await expect(selectRecipients(pool, { lat: NaN, lng: 0, cap: 1, now: NOW })).rejects.toThrow(/lat/);
    await expect(selectRecipients(pool, { lat: 0, lng: Infinity, cap: 1, now: NOW })).rejects.toThrow(/lng/);
  });
});

describe('selectRecipients maxKm', () => {
  const within = (maxKm?: number) => selectRecipients(pool, { ...ORIGIN, cap: 10, now: NOW, maxKm });
  it('excludes a recipient ~30 km away when maxKm=5, includes it when omitted; keeps a 4 km one', async () => {
    const far = await addRecipient(40.97, -74.0); // ~30 km north
    const near = await addRecipient(40.736, -74.0); // ~4 km north
    expect(distanceKm(ORIGIN, { lat: 40.97, lng: -74 })).toBeGreaterThan(29);
    expect(distanceKm(ORIGIN, { lat: 40.736, lng: -74 })).toBeLessThan(4.1);
    expect((await within(5)).map((r) => r.id)).toEqual([near.id]);
    expect((await within()).map((r) => r.id)).toEqual([near.id, far.id]);
  });
  it('boundary: <= maxKm is included, just beyond is not', async () => {
    const p = { lat: 40.74, lng: -74.0 };
    const r = await addRecipient(p.lat, p.lng);
    const d = distanceKm(ORIGIN, p);
    expect((await within(d + 1e-6)).map((x) => x.id)).toEqual([r.id]);
    expect(await within(d - 1e-6)).toEqual([]);
  });
  it('rejects non-positive or non-finite maxKm', async () => {
    for (const m of [0, -1, NaN, Infinity]) await expect(within(m)).rejects.toThrow(/maxKm/);
  });
});

