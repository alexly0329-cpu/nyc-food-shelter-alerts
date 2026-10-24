import { createHash, createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '../src/db.js';
import { encryptPhone, phoneHash } from '../src/crypto.js';
import { dailySummary, dayWindow } from '../src/ops/daily-summary.js';
import { logEvent } from '../src/ops/log.js';
import { buildServer } from '../src/server.js';
import { createQueue, type BossLike } from '../src/queue.js';
import { runSendJob, type Sender } from '../src/alerts/send.js';

const pool = getPool();
afterAll(async () => { await pool.end(); });
const hours = (w: { start: Date; end: Date }) => (w.end.getTime() - w.start.getTime()) / 3_600_000;

describe('dayWindow (America/New_York)', () => {
  it('is 24h on a normal day, local midnight to midnight', () => {
    const w = dayWindow(new Date('2026-06-01T16:00:00Z'));
    expect(w.start.toISOString()).toBe('2026-06-01T04:00:00.000Z');
    expect(hours(w)).toBe(24);
  });
  it('is 23h on spring-forward day 2026-03-08', () => {
    const w = dayWindow(new Date('2026-03-08T17:00:00Z'));
    expect(w.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(hours(w)).toBe(23);
  });
  it('is 25h on fall-back day 2026-11-01', () => {
    const w = dayWindow(new Date('2026-11-01T17:00:00Z'));
    expect(w.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(hours(w)).toBe(25);
  });
  it('uses the New York day, not the UTC day', () => {
    // 02:00Z on 2026-06-02 is still June 1 at 10 pm in New York
    expect(dayWindow(new Date('2026-06-02T02:00:00Z')).start.toISOString()).toBe('2026-06-01T04:00:00.000Z');
  });
});

describe('dailySummary', () => {
  let providerId: string;
  let seq = 0;
  const DAY = new Date('2026-06-01T16:00:00Z');
  const IN = new Date('2026-06-01T15:00:00Z');
  const BEFORE = new Date('2026-06-01T03:59:00Z');
  const AFTER = new Date('2026-06-02T04:00:00Z'); // end is exclusive

  beforeEach(async () => {
    await pool.query('TRUNCATE deliveries, alerts, consents, recipients, providers CASCADE');
    providerId = (await pool.query(
      `INSERT INTO providers (name, address, contact, status) VALUES ('P', '1 Main St', 'c', 'approved') RETURNING id`,
    )).rows[0].id;
  });
  const alert = async (created: Date) =>
    (await pool.query(
      `INSERT INTO alerts (provider_id, service_type, address, lat, lng, message, starts_at, ends_at, capacity_cap, idempotency_key, created_at)
       VALUES ($1,'food','1 Main St',40.7,-74,'m','2026-06-01T20:00Z','2026-06-01T22:00Z',10,$2,$3) RETURNING id`,
      [providerId, `k${seq++}`, created],
    )).rows[0].id as string;
  const delivery = async (alertId: string, o: { status: string; claimed?: boolean; vonage?: boolean; created: Date }) => {
    const phone = `+1718555${1000 + seq++}`;
    const rid = (await pool.query(
      `INSERT INTO recipients (phone, phone_hash, channel, language, zip, lat, lng, enrolled_by_provider_id)
       VALUES ($1,$2,'sms','en','11201',40.7,-74,$3) RETURNING id`,
      [encryptPhone(phone), phoneHash(phone), providerId],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO deliveries (alert_id, recipient_id, status, claimed_at, vonage_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [alertId, rid, o.status, o.claimed ? o.created : null, o.vonage ? `v${seq}` : null, o.created],
    );
  };

  it('counts only the window; sent means attempted', async () => {
    const a = await alert(IN);
    await alert(BEFORE);
    await alert(AFTER);
    await delivery(a, { status: 'delivered', vonage: true, created: IN });
    await delivery(a, { status: 'delivered', vonage: true, claimed: true, created: IN });
    await delivery(a, { status: 'failed', claimed: true, created: IN });
    await delivery(a, { status: 'queued', claimed: true, created: IN }); // outcome unknown, still attempted
    await delivery(a, { status: 'stopped', created: IN }); // never attempted
    await delivery(a, { status: 'failed', created: IN }); // never attempted
    await delivery(a, { status: 'delivered', vonage: true, created: BEFORE });
    await delivery(a, { status: 'delivered', vonage: true, created: AFTER });
    expect(await dailySummary(pool, DAY)).toEqual({
      alerts: 1, sent: 4, delivered: 2, failed: 2, stopped: 1, deliveryRate: 0.5,
    });
  });

  it('deliveryRate is exactly 0 (not NaN) when nothing was sent', async () => {
    expect(await dailySummary(pool, DAY)).toEqual({ alerts: 0, sent: 0, delivered: 0, failed: 0, stopped: 0, deliveryRate: 0 });
    const a = await alert(IN);
    await delivery(a, { status: 'stopped', created: IN });
    const s = await dailySummary(pool, DAY);
    expect(s.sent).toBe(0);
    expect(s.deliveryRate).toBe(0);
  });
});

describe('logEvent', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
  });
  afterEach(() => vi.restoreAllMocks());
  const line = () => { expect(out).toHaveLength(1); expect(out[0].endsWith('\n')).toBe(true); return JSON.parse(out[0]); };

  it('writes one valid JSON line with event and ISO ts', () => {
    logEvent('queue_error', { reason: 'boom' });
    const j = line();
    expect(j.event).toBe('queue_error');
    expect(new Date(j.ts).toISOString()).toBe(j.ts);
    expect(j.reason).toBe('boom');
  });
  it('drops fields that are not whitelisted', () => {
    logEvent('send_failed', { alertId: 'a', phone: '+17185551234', text: 'hello', status: 3 });
    const j = line();
    expect(Object.keys(j).sort()).toEqual(['alertId', 'event', 'status', 'ts']);
  });
  it('truncates strings to 200 chars', () => {
    logEvent('webhook_error', { reason: 'x'.repeat(500) });
    expect(line().reason).toHaveLength(200);
  });
  it('redacts digit runs of 7 or more, keeps short ones', () => {
    logEvent('webhook_error', { reason: 'bad +1 (718) 555-1234 or 17185551234 or 7185551234 id 123456' });
    const r = line().reason as string;
    expect(r).not.toMatch(/\d{7}/);
    expect(r).toContain('[redacted]');
    expect(r).toContain('123456');
  });
  it('redacts a digit run split by the truncation boundary', () => {
    logEvent('webhook_error', { reason: 'a'.repeat(195) + '17185551234' });
    expect(line().reason).not.toMatch(/\d{7}/);
  });
});

describe('send_failed log', () => {
  afterEach(() => vi.restoreAllMocks());
  it('logs ids and channel only: no phone number, no message text', async () => {
    await pool.query('TRUNCATE deliveries, alerts, consents, recipients, providers CASCADE');
    const providerId = (await pool.query(
      `INSERT INTO providers (name, address, contact, status) VALUES ('Pantry', '1 Main St', 'c', 'approved') RETURNING id`,
    )).rows[0].id;
    const phone = '+17185551234';
    const rid = (await pool.query(
      `INSERT INTO recipients (phone, phone_hash, channel, language, zip, lat, lng, enrolled_by_provider_id)
       VALUES ($1,$2,'sms','en','11201',40.7,-74,$3) RETURNING id`,
      [encryptPhone(phone), phoneHash(phone), providerId],
    )).rows[0].id;
    await pool.query(`INSERT INTO consents (recipient_id, provider_id, method, consent_text_version) VALUES ($1,$2,'verbal','v1')`, [rid, providerId]);
    const alertId = (await pool.query(
      `INSERT INTO alerts (provider_id, service_type, address, lat, lng, message, starts_at, ends_at, capacity_cap, verification_status, idempotency_key)
       VALUES ($1,'food','1 Main St',40.7,-74,'Secret hot meals tonight','2026-06-01T21:00Z','2026-06-01T23:00Z',10,'verified','k') RETURNING id`,
      [providerId],
    )).rows[0].id as string;
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
    const sender: Sender = {
      sendSms: async (to, text) => { throw new Error(`carrier rejected ${to}: ${text}`); },
      startCall: async () => ({ id: 'x' }),
    };
    await runSendJob({ db: pool, sender, enqueue: async () => {}, now: () => new Date('2026-06-01T16:00:00Z'), sleep: async () => {} }, alertId);
    const lines = out.map((s) => JSON.parse(s));
    expect(lines).toHaveLength(1);
    const d = (await pool.query('SELECT id, status FROM deliveries WHERE alert_id = $1', [alertId])).rows[0];
    expect(d.status).toBe('failed');
    expect(lines[0]).toMatchObject({ event: 'send_failed', alertId, deliveryId: d.id, channel: 'sms' });
    const raw = out.join('');
    expect(raw).not.toContain('1234');
    expect(raw).not.toContain('Secret');
  });
});

describe('webhook and queue log events', () => {
  afterEach(() => vi.restoreAllMocks());
  const NOW = new Date('2026-06-01T12:00:00Z');
  const capture = () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
    return out;
  };
  const mk = (db: unknown) => buildServer({
    db: db as never, tavily: { search: async () => ({ results: [] }) }, geocode: async () => null, enqueue: async () => {}, now: () => NOW,
    secureCookies: false, sender: { sendSms: async () => ({ id: 'm' }), startCall: async () => ({ id: 'c' }) }, signatureSecret: () => 'whsec-test',
  });
  const token = (body: string) => {
    const enc = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url');
    const head = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ iat: Math.floor(NOW.getTime() / 1000), payload_hash: createHash('sha256').update(body).digest('hex') })}`;
    return `${head}.${createHmac('sha256', 'whsec-test').update(head).digest('base64url')}`;
  };

  it('rejected signature logs webhook_rejected with the route', async () => {
    const out = capture();
    const app = mk(pool);
    const r = await app.inject({ method: 'POST', url: '/webhooks/vonage/inbound', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(401);
    expect(out.map((l) => JSON.parse(l))).toMatchObject([{ event: 'webhook_rejected', route: '/webhooks/vonage/inbound', reason: 'invalid_signature' }]);
  });

  it('an exception in a webhook handler logs webhook_error without the message', async () => {
    const out = capture();
    const db = { query: async () => { throw new Error('db down for +17185551234'); } };
    const body = JSON.stringify({ message_uuid: 'u1', status: 'delivered' });
    const r = await mk(db).inject({ method: 'POST', url: '/webhooks/vonage/status', payload: body, headers: { 'content-type': 'application/json', authorization: `Bearer ${token(body)}` } });
    expect(r.statusCode).toBe(500);
    expect(out.map((l) => JSON.parse(l))).toMatchObject([{ event: 'webhook_error', route: '/webhooks/vonage/status', reason: 'Error' }]);
    expect(out.join('')).not.toContain('1234');
  });

  it('a throwing send job logs queue_error and rethrows for pg-boss retry', async () => {
    const out = capture();
    let handler: (jobs: Array<{ data: { alertId: string } }>) => Promise<void> = async () => {};
    const boss = {
      start: async () => {}, stop: async () => {}, createQueue: async () => {}, send: async () => 'j',
      work: async (_n: string, _o: object, h: typeof handler) => { handler = h; return 'w'; }, on: () => {},
    } satisfies BossLike;
    const q = createQueue({ pool: { query: async () => { throw new Error('boom'); } } as never, sender: {} as never }, boss);
    await q.start();
    await expect(handler([{ data: { alertId: 'a1' } }])).rejects.toThrow('boom');
    expect(out.map((l) => JSON.parse(l))).toMatchObject([{ event: 'queue_error', alertId: 'a1', reason: 'boom' }]);
  });
});
