import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { hashPassword } from '../src/auth/users.js';
import { getPool } from '../src/db.js';
import { buildServer } from '../src/server.js';

const pool = getPool();
const NOW = new Date('2026-06-01T12:00:00Z');
const HOUR = 3_600_000;
const SECRET = 'whsec-test';
const PW = 'correct horse battery';
const PHONE = '(718) 555-0142';

const verifiedTavily = () => ({
  search: vi.fn(async (_q: string) => ({ results: [{ title: 'Test Pantry', content: 'Test Pantry at 123 Main Street, Brooklyn', url: 'https://x.test' }] })),
});

let app: FastifyInstance;
type Geo = { lat: number; lng: number } | null;
let enqueue: Mock<(id: string, at: Date) => Promise<void>>;
let geocode: Mock<(a: string) => Promise<Geo>>;
let sendSms: Mock<(to: string, text: string) => Promise<{ id: string }>>;
let tavily: ReturnType<typeof verifiedTavily>;
let secret: string | undefined;
let secure = false;

async function mkApp() {
  enqueue = vi.fn(async (_id: string, _at: Date) => {});
  geocode = vi.fn(async (_a: string): Promise<Geo> => ({ lat: 40.7, lng: -74 }));
  sendSms = vi.fn(async (_to: string, _t: string) => ({ id: 'm1' }));
  tavily = verifiedTavily();
  app = buildServer({
    db: pool, tavily, geocode, enqueue, now: () => NOW, secureCookies: secure,
    sender: { sendSms, startCall: vi.fn(async () => ({ id: 'c1' })) },
    signatureSecret: () => secret,
  });
  await app.ready();
}

const json = { 'content-type': 'application/json' };
async function post(url: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { ...json, ...(cookie ? { cookie } : {}), ...headers } });
}
const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

let n = 0;
async function mkProvider(status: 'pending' | 'approved', name = 'Test Pantry') {
  const email = `staff${n++}@example.org`;
  const p = (await pool.query(`INSERT INTO providers (name, address, contact, status) VALUES ($1, '123 Main St', 'c', $2) RETURNING id`, [name, status])).rows[0].id as string;
  const u = (await pool.query(`INSERT INTO provider_users (provider_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id`, [p, email, await hashPassword(PW)])).rows[0].id as string;
  return { providerId: p, userId: u, email };
}
async function mkAdmin() {
  const email = `admin${n++}@example.org`;
  const id = (await pool.query(`INSERT INTO provider_users (email, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id`, [email, await hashPassword(PW)])).rows[0].id as string;
  return { id, email };
}
async function cookieFor(email: string) {
  const r = await post('/api/login', { email, password: PW });
  expect(r.statusCode).toBe(200);
  return (r.headers['set-cookie'] as string).split(';')[0];
}
const staff = async (status: 'pending' | 'approved' = 'approved') => {
  const p = await mkProvider(status);
  return { ...p, cookie: await cookieFor(p.email) };
};
const admin = async () => {
  const a = await mkAdmin();
  return { ...a, cookie: await cookieFor(a.email) };
};

const alertBody = (o: Record<string, unknown> = {}) => ({
  serviceType: 'food', address: '123 Main St, Brooklyn, NY',
  startsAt: new Date(NOW.getTime() + HOUR).toISOString(), endsAt: new Date(NOW.getTime() + 3 * HOUR).toISOString(),
  message: 'Free hot meals tonight', capacityCap: 50, urgent: false, idempotencyKey: `k${n++}`, ...o,
});
const enrollBody = (o: Record<string, unknown> = {}) => ({ phone: PHONE, channel: 'sms', language: 'en', zip: '11201', method: 'verbal', scriptConfirmed: true, ...o });
async function mkNeedsReview(providerId: string, geo: boolean) {
  return (await pool.query(
    `INSERT INTO alerts (provider_id, service_type, address, lat, lng, message, starts_at, ends_at, capacity_cap, idempotency_key, verification_status)
     VALUES ($1, 'food', '1 Main St', $2, $3, 'm', $4, $5, 10, $6, 'needs_review') RETURNING id`,
    [providerId, geo ? 40.7 : null, geo ? -74 : null, new Date(NOW.getTime() + HOUR), new Date(NOW.getTime() + 2 * HOUR), `k${n++}`],
  )).rows[0].id as string;
}

beforeEach(async () => {
  await pool.query('TRUNCATE deliveries, alerts, consents, recipients, sessions, audit_log, provider_users, providers CASCADE');
  secret = SECRET;
  secure = false;
  await mkApp();
});
afterEach(() => app.close());
afterAll(() => pool.end());

describe('auth and sessions', () => {
  it('unauthenticated GET /api/alerts is 401', async () => {
    const r = await get('/api/alerts');
    expect(r.statusCode).toBe(401);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('login sets HttpOnly SameSite=Lax cookie; Secure only when enabled', async () => {
    const p = await mkProvider('approved');
    const r = await post('/api/login', { email: p.email, password: PW });
    expect(r.json()).toEqual({ ok: true });
    const c = r.headers['set-cookie'] as string;
    expect(c).toMatch(/^session=[0-9a-f]{64};/);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=43200');
    expect(c).not.toContain('Secure');
    await app.close();
    secure = true;
    await mkApp();
    const r2 = await post('/api/login', { email: p.email, password: PW });
    expect(r2.headers['set-cookie']).toContain('Secure');
  });

  it('wrong password is 401 with no cookie', async () => {
    const p = await mkProvider('approved');
    const r = await post('/api/login', { email: p.email, password: 'nope-nope-nope' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('logout clears cookie and deletes the session', async () => {
    const s = await staff();
    const r = await post('/api/logout', {}, s.cookie);
    expect(r.statusCode).toBe(200);
    expect(r.headers['set-cookie']).toContain('Max-Age=0');
    expect((await get('/api/alerts', s.cookie)).statusCode).toBe(401);
  });

  it('pending staff: 200 on /api/me, 403 on enroll and alerts', async () => {
    const s = await staff('pending');
    const me = await get('/api/me', s.cookie);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ providerName: 'Test Pantry', status: 'pending', role: 'staff' });
    expect((await post('/api/enroll', enrollBody(), s.cookie)).statusCode).toBe(403);
    expect((await post('/api/alerts', alertBody(), s.cookie)).statusCode).toBe(403);
    expect((await get('/api/me')).statusCode).toBe(401);
  });

  it('non-JSON content type on a POST /api route is 415', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: 'email=a', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(r.statusCode).toBe(415);
    const r2 = await app.inject({ method: 'POST', url: '/api/login', payload: '{}' });
    expect(r2.statusCode).toBe(415);
  });
});

describe('apply', () => {
  const body = (o: Record<string, unknown> = {}) => ({
    name: 'Test Pantry', address: '123 Main St, Brooklyn, NY', contactName: 'Pat', phone: '(212) 555-0123', email: 'new@example.org', password: PW, ...o,
  });

  it('stores the tavily result and returns 201', async () => {
    const r = await post('/api/apply', body());
    expect(r.statusCode).toBe(201);
    const { providerId } = r.json();
    const row = (await pool.query('SELECT status, tavily_result, tavily_checked_at FROM providers WHERE id = $1', [providerId])).rows[0];
    expect(row.status).toBe('pending');
    expect(row.tavily_result.status).toBe('likely_legit');
    expect(row.tavily_checked_at).not.toBeNull();
  });

  it('succeeds with a flagged result when tavily throws', async () => {
    tavily.search.mockRejectedValue(new Error('boom'));
    const r = await post('/api/apply', body());
    expect(r.statusCode).toBe(201);
    const row = (await pool.query('SELECT tavily_result FROM providers WHERE id = $1', [r.json().providerId])).rows[0];
    expect(row.tavily_result.status).toBe('flagged');
  });

  it('duplicate email 409, invalid input 400 without echoing the password', async () => {
    expect((await post('/api/apply', body())).statusCode).toBe(201);
    expect((await post('/api/apply', body())).statusCode).toBe(409);
    const bad = await post('/api/apply', body({ email: 'x@y.org', password: 'short' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('short');
    expect((await post('/api/apply', { name: 5 })).statusCode).toBe(400);
  });
});

describe('enroll', () => {
  it('201 {ok:true}, never echoes phone or ids', async () => {
    const s = await staff();
    const r = await post('/api/enroll', enrollBody(), s.cookie);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ ok: true });
    expect(r.body).not.toMatch(/718|555|0142/);
  });

  it('scriptConfirmed false is 400 SCRIPT_NOT_CONFIRMED; non-NYC zip 400 ZIP_NOT_NYC', async () => {
    const s = await staff();
    const a = await post('/api/enroll', enrollBody({ scriptConfirmed: false }), s.cookie);
    expect(a.statusCode).toBe(400);
    expect(a.json().error).toBe('SCRIPT_NOT_CONFIRMED');
    const b = await post('/api/enroll', enrollBody({ zip: '90210' }), s.cookie);
    expect(b.statusCode).toBe(400);
    expect(b.json().error).toBe('ZIP_NOT_NYC');
    expect((await post('/api/enroll', { phone: PHONE }, s.cookie)).statusCode).toBe(400);
  });
});

describe('alerts', () => {
  it('happy path enqueues once; same idempotency key twice enqueues once', async () => {
    const s = await staff();
    const b = alertBody({ idempotencyKey: 'same' });
    const r1 = await post('/api/alerts', b, s.cookie);
    expect(r1.statusCode).toBe(201);
    expect(r1.json().status).toBe('verified');
    const r2 = await post('/api/alerts', b, s.cookie);
    expect(r2.statusCode).toBe(201);
    expect(r2.json().alertId).toBe(r1.json().alertId);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('accepts the Idempotency-Key header; missing key is 400', async () => {
    const s = await staff();
    const { idempotencyKey: _k, ...noKey } = alertBody();
    expect((await post('/api/alerts', noKey, s.cookie)).statusCode).toBe(400);
    const r = await post('/api/alerts', noKey, s.cookie, { 'idempotency-key': 'hdr-1' });
    expect(r.statusCode).toBe(201);
  });

  it('past endsAt is 400; unapproved provider is 403', async () => {
    const s = await staff();
    const past = await post('/api/alerts', alertBody({ startsAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(), endsAt: new Date(NOW.getTime() - HOUR).toISOString() }), s.cookie);
    expect(past.statusCode).toBe(400);
    expect(past.json().error).toBe('INVALID_INPUT');
    expect((await post('/api/alerts', alertBody({ startsAt: 'garbage' }), s.cookie)).statusCode).toBe(400);
    const p = await staff('pending');
    expect((await post('/api/alerts', alertBody(), p.cookie)).statusCode).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('provider A never sees provider B alerts; counts right; no phones or recipient ids', async () => {
    const a = await staff();
    const b = await staff();
    await post('/api/enroll', enrollBody(), a.cookie);
    const ra = (await post('/api/alerts', alertBody({ message: 'from A' }), a.cookie)).json().alertId as string;
    const rb = (await post('/api/alerts', alertBody({ message: 'from B' }), b.cookie)).json().alertId as string;
    const rec = (await pool.query('SELECT id FROM recipients')).rows[0].id as string;
    const ins = (status: string, vonage: string | null, claimed: boolean) =>
      pool.query(`INSERT INTO deliveries (alert_id, recipient_id, status, vonage_id, claimed_at) VALUES ($1, $2, $3, $4, $5)`, [
        ra, rec, status, vonage, claimed ? new Date() : null,
      ]);
    // unique(alert, recipient): use extra alerts of A for the other statuses
    await ins('delivered', 'v1', true);
    const extra = async (status: string, vonage: string | null, claimed: boolean) => {
      const id = (await post('/api/alerts', alertBody({ message: `x-${status}-${claimed}` }), a.cookie)).json().alertId as string;
      await pool.query(`INSERT INTO deliveries (alert_id, recipient_id, status, vonage_id, claimed_at) VALUES ($1, $2, $3, $4, $5)`, [id, rec, status, vonage, claimed ? new Date() : null]);
      return id;
    };
    const unknown = await extra('queued', null, true);
    await pool.query(`INSERT INTO deliveries (alert_id, recipient_id, status) VALUES ($1, $2, 'delivered')`, [rb, rec]);

    const r = await get('/api/alerts', a.cookie);
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Array<{ alertId: string; title: string; texted: number; delivered: number }>;
    expect(rows.map((x) => x.alertId)).not.toContain(rb);
    expect(rows.find((x) => x.alertId === ra)).toMatchObject({ texted: 1, delivered: 1 });
    expect(rows.find((x) => x.alertId === unknown)).toMatchObject({ texted: 1, delivered: 0 });
    expect(r.body).not.toContain(rec);
    expect(r.body).not.toMatch(/718|0142/);
    const rBrows = (await get('/api/alerts', b.cookie)).json() as Array<{ alertId: string }>;
    expect(rBrows.map((x) => x.alertId)).toEqual([rb]);
  });
});

describe('admin', () => {
  it('staff gets 403 on every admin route', async () => {
    const s = await staff();
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [method, url] of [
      ['GET', '/api/admin/providers'], ['POST', `/api/admin/providers/${id}/approve`], ['POST', `/api/admin/providers/${id}/suspend`],
      ['GET', '/api/admin/alerts'], ['POST', `/api/admin/alerts/${id}/approve`],
    ] as const) {
      const r = await app.inject({ method, url, payload: method === 'POST' ? '{}' : undefined, headers: { ...json, cookie: s.cookie } });
      expect(r.statusCode, url).toBe(403);
    }
    expect((await get('/api/admin/providers')).statusCode).toBe(401);
  });

  it('non-UUID :id is 400', async () => {
    const a = await admin();
    expect((await post('/api/admin/providers/not-a-uuid/approve', {}, a.cookie)).statusCode).toBe(400);
    expect((await post('/api/admin/alerts/1%27/approve', {}, a.cookie)).statusCode).toBe(400);
  });

  it('lists providers by status without passwords; approves and suspends with audit rows', async () => {
    const a = await admin();
    const p = await mkProvider('pending');
    const list = await get('/api/admin/providers?status=pending', a.cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.body).not.toMatch(/password|argon/);
    expect((await get('/api/admin/providers?status=bogus', a.cookie)).statusCode).toBe(400);

    expect((await post(`/api/admin/providers/${p.providerId}/approve`, {}, a.cookie)).statusCode).toBe(200);
    expect((await pool.query('SELECT status FROM providers WHERE id = $1', [p.providerId])).rows[0].status).toBe('approved');
    expect((await post(`/api/admin/providers/${p.providerId}/suspend`, {}, a.cookie)).statusCode).toBe(200);
    expect((await pool.query('SELECT status FROM providers WHERE id = $1', [p.providerId])).rows[0].status).toBe('suspended');
    const audit = (await pool.query('SELECT action, actor_id FROM audit_log ORDER BY created_at')).rows;
    expect(audit.map((x) => x.action)).toEqual(['provider.approve', 'provider.suspend']);
    expect(audit[0].actor_id).toBe(a.id);
    expect((await post('/api/admin/providers/00000000-0000-4000-8000-000000000000/approve', {}, a.cookie)).statusCode).toBe(404);
  });

  it('approving a needs_review alert enqueues exactly one send; second approve is 409', async () => {
    const a = await admin();
    const p = await mkProvider('approved');
    const id = await mkNeedsReview(p.providerId, true);
    const list = await get('/api/admin/alerts?status=needs_review', a.cookie);
    expect(list.json().map((x: { id: string }) => x.id)).toEqual([id]);
    const r1 = await post(`/api/admin/alerts/${id}/approve`, {}, a.cookie);
    expect(r1.statusCode).toBe(200);
    const r2 = await post(`/api/admin/alerts/${id}/approve`, {}, a.cookie);
    expect(r2.statusCode).toBe(409);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toBe(id);
    expect((await pool.query('SELECT verification_status FROM alerts WHERE id = $1', [id])).rows[0].verification_status).toBe('verified');
    expect((await pool.query(`SELECT actor_id FROM audit_log WHERE action = 'alert.approve' AND target_id = $1`, [id])).rows[0].actor_id).toBe(a.id);
  });

  it('concurrent approvals enqueue once', async () => {
    const a = await admin();
    const p = await mkProvider('approved');
    const id = await mkNeedsReview(p.providerId, true);
    const rs = await Promise.all([1, 2, 3].map(() => post(`/api/admin/alerts/${id}/approve`, {}, a.cookie)));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('null-geo alert is geocoded first; failing geocode is 409 with no enqueue', async () => {
    const a = await admin();
    const p = await mkProvider('approved');
    const id = await mkNeedsReview(p.providerId, false);
    geocode.mockResolvedValueOnce(null);
    const bad = await post(`/api/admin/alerts/${id}/approve`, {}, a.cookie);
    expect(bad.statusCode).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
    expect((await pool.query('SELECT verification_status FROM alerts WHERE id = $1', [id])).rows[0].verification_status).toBe('needs_review');
    const ok = await post(`/api/admin/alerts/${id}/approve`, {}, a.cookie);
    expect(ok.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT lat, lng FROM alerts WHERE id = $1', [id])).rows[0]).toEqual({ lat: 40.7, lng: -74 });
  });

  it('enqueue failure reverts to needs_review with a generic 502', async () => {
    const a = await admin();
    const p = await mkProvider('approved');
    const id = await mkNeedsReview(p.providerId, true);
    enqueue.mockRejectedValue(new Error('secret-queue-detail'));
    const r = await post(`/api/admin/alerts/${id}/approve`, {}, a.cookie);
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain('secret-queue-detail');
    expect((await pool.query('SELECT verification_status FROM alerts WHERE id = $1', [id])).rows[0].verification_status).toBe('needs_review');
  });
});

describe('webhooks', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  function token(body: string, o: { secret?: string; hash?: string } = {}) {
    const enc = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url');
    const head = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ iat: Math.floor(NOW.getTime() / 1000), payload_hash: o.hash ?? sha(body) })}`;
    return `${head}.${createHmac('sha256', o.secret ?? SECRET).update(head).digest('base64url')}`;
  }
  const hook = (url: string, body: string, auth?: string) =>
    app.inject({ method: 'POST', url, payload: body, headers: { ...json, ...(auth ? { authorization: `Bearer ${auth}` } : {}) } });
  async function enrolled() {
    const s = await staff();
    await post('/api/enroll', enrollBody(), s.cookie);
    return s;
  }
  const activeConsents = async () => Number((await pool.query('SELECT count(*) FROM consents WHERE revoked_at IS NULL')).rows[0].count);

  it('bad, missing or wrong-body signature is 401 and does nothing', async () => {
    await enrolled();
    const body = JSON.stringify({ from: '17185550142', text: 'STOP' });
    for (const auth of [undefined, 'junk', token(body, { secret: 'other' }), token(body, { hash: sha('different') })]) {
      expect((await hook('/webhooks/vonage/inbound', body, auth)).statusCode).toBe(401);
    }
    expect(await activeConsents()).toBe(1);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('no secret configured fails closed', async () => {
    await enrolled();
    const body = JSON.stringify({ from: '17185550142', text: 'STOP' });
    const t = token(body);
    secret = undefined;
    expect((await hook('/webhooks/vonage/inbound', body, t)).statusCode).toBe(401);
    expect(await activeConsents()).toBe(1);
  });

  it.each([['string', '17185550142'], ['object', { number: '17185550142' }]])('valid inbound STOP (from as %s) revokes consent and replies via sender', async (_n, from) => {
    await enrolled();
    const body = JSON.stringify({ from, text: 'STOP' });
    const r = await hook('/webhooks/vonage/inbound', body, token(body));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({});
    expect(await activeConsents()).toBe(0);
    expect(sendSms).toHaveBeenCalledWith('17185550142', expect.stringContaining('unsubscribed'));
  });

  it('a failing reply send still returns 200', async () => {
    await enrolled();
    sendSms.mockRejectedValue(new Error('vonage down'));
    const body = JSON.stringify({ from: '17185550142', text: 'STOP' });
    expect((await hook('/webhooks/vonage/inbound', body, token(body))).statusCode).toBe(200);
    expect(await activeConsents()).toBe(0);
  });

  it('valid status event updates a delivery', async () => {
    const s = await enrolled();
    const alertId = (await post('/api/alerts', alertBody(), s.cookie)).json().alertId as string;
    const rec = (await pool.query('SELECT id FROM recipients')).rows[0].id;
    await pool.query(`INSERT INTO deliveries (alert_id, recipient_id, status, vonage_id) VALUES ($1, $2, 'queued', 'uuid-1')`, [alertId, rec]);
    const body = JSON.stringify({ message_uuid: 'uuid-1', status: 'delivered' });
    expect((await hook('/webhooks/vonage/status', body, token(body))).statusCode).toBe(200);
    expect((await pool.query('SELECT status FROM deliveries')).rows[0].status).toBe('delivered');
    const bad = await hook('/webhooks/vonage/status', body, 'junk');
    expect(bad.statusCode).toBe(401);
  });
});

describe('errors', () => {
  it('unexpected errors are a generic 500 with no leak', async () => {
    const s = await staff();
    tavily.search.mockRejectedValue(new Error('x')); // swallowed by design, so force a throw elsewhere
    geocode.mockImplementation(async () => { throw new Error('SECRET-INTERNAL at /src/foo.ts:12'); });
    const r = await post('/api/alerts', alertBody(), s.cookie);
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'internal_error' });
    expect(r.body).not.toMatch(/SECRET|\.ts|at /);
  });

  it('malformed JSON body is 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/login', payload: '{nope', headers: json });
    expect(r.statusCode).toBe(400);
  });
});
