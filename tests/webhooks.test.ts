import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../src/db.js';
import { enrollRecipient } from '../src/recipients/enroll.js';
import { handleInbound, handleStatus, isStopKeyword, verifyVonageSignature } from '../src/webhooks/vonage.js';

const pool = getPool();
const deps = { db: pool };
const BARE = '17185550142';
const E164 = '+17185550142';
const CONFIRM = "You're unsubscribed from NYC food and shelter alerts. No more messages will be sent.";
const GENERIC = 'NYC food and shelter alerts. Reply STOP to opt out.';

let providerId: string;
let seq = 0;

async function mkProvider(name: string, contact: string) {
  return (await pool.query(`INSERT INTO providers (name, address, contact, status) VALUES ($1, '1 Main St', $2, 'approved') RETURNING id`, [name, contact])).rows[0].id as string;
}
const enroll = (phone = E164, pid = providerId) =>
  enrollRecipient(pool, { providerId: pid, phone, channel: 'sms', language: 'en', zip: '11201', method: 'verbal', scriptConfirmed: true }).then((r) => r.recipientId);
async function addDelivery(recipientId: string, status: string, vonageId: string | null, ageMin = 0) {
  const alertId = (await pool.query(
    `INSERT INTO alerts (provider_id, service_type, address, lat, lng, message, starts_at, ends_at, capacity_cap, idempotency_key)
     VALUES ($1, 'food', '1 Main St', 40.7, -74.0, 'm', now(), now() + interval '1 hour', 5, $2) RETURNING id`,
    [providerId, `k${seq++}`],
  )).rows[0].id as string;
  return (await pool.query(
    `INSERT INTO deliveries (alert_id, recipient_id, status, vonage_id, created_at) VALUES ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval) RETURNING id`,
    [alertId, recipientId, status, vonageId, String(ageMin)],
  )).rows[0].id as string;
}
const dStatus = async (id: string) => (await pool.query('SELECT status FROM deliveries WHERE id = $1', [id])).rows[0].status;
const rStatus = async (id: string) => (await pool.query('SELECT status FROM recipients WHERE id = $1', [id])).rows[0].status;
const activeConsents = async (id: string) =>
  Number((await pool.query('SELECT count(*) FROM consents WHERE recipient_id = $1 AND revoked_at IS NULL', [id])).rows[0].count);

beforeEach(async () => {
  await pool.query('TRUNCATE deliveries, alerts, consents, recipients, providers CASCADE');
  providerId = await mkProvider('Pantry', JSON.stringify({ contactName: 'Pat', phone: '212-555-0123' }));
});
afterAll(() => pool.end());

describe('isStopKeyword', () => {
  it.each(['STOP', 'stop', ' Stop ', 'STOP.', 'Stop!', 'STOPALL', 'UNSUBSCRIBE', 'cancel', 'QUIT', 'end'])('true for %j', (t) => {
    expect(isStopKeyword(t)).toBe(true);
  });
  it.each(['stopping by at 5', "please don't stop", 'stop the clock', '', 'ENDING', 'STO'])('false for %j', (t) => {
    expect(isStopKeyword(t)).toBe(false);
  });
  it('false for non-string', () => {
    expect(isStopKeyword(undefined as never)).toBe(false);
    expect(isStopKeyword(null as never)).toBe(false);
    expect(isStopKeyword(5 as never)).toBe(false);
  });
});

describe('handleInbound STOP', () => {
  it.each([BARE, E164])('revokes consent and stops latest delivery (from %s)', async (from) => {
    const id = await enroll();
    const older = await addDelivery(id, 'delivered', 'a', 60);
    const newest = await addDelivery(id, 'queued', 'b', 1);
    expect(await handleInbound(deps, { from, text: 'stop' })).toEqual({ reply: CONFIRM });
    expect(await rStatus(id)).toBe('stopped');
    expect(await activeConsents(id)).toBe(0);
    expect(await dStatus(newest)).toBe('stopped');
    expect(await dStatus(older)).toBe('delivered');
  });
  it.each([' Stop ', 'STOP.', 'UNSUBSCRIBE'])('revokes on %j', async (text) => {
    const id = await enroll();
    await handleInbound(deps, { from: BARE, text });
    expect(await rStatus(id)).toBe('stopped');
  });
  it('unknown number gets same reply and changes nothing', async () => {
    const id = await enroll('+17185550199');
    expect(await handleInbound(deps, { from: BARE, text: 'STOP' })).toEqual({ reply: CONFIRM });
    expect(await rStatus(id)).toBe('active');
    expect(await handleInbound(deps, { from: 'garbage', text: 'STOP' })).toEqual({ reply: CONFIRM });
  });
  it('is idempotent', async () => {
    const id = await enroll();
    const d = await addDelivery(id, 'queued', 'a');
    await handleInbound(deps, { from: BARE, text: 'STOP' });
    expect(await handleInbound(deps, { from: BARE, text: 'STOP' })).toEqual({ reply: CONFIRM });
    expect(await rStatus(id)).toBe('stopped');
    expect(await dStatus(d)).toBe('stopped');
  });
  it('leaves a failed latest delivery failed', async () => {
    const id = await enroll();
    const d = await addDelivery(id, 'failed', 'a');
    await handleInbound(deps, { from: BARE, text: 'STOP' });
    expect(await dStatus(d)).toBe('failed');
    expect(await rStatus(id)).toBe('stopped');
  });
  it('does not revoke on "stopping by at 5"', async () => {
    const id = await enroll();
    expect(await handleInbound(deps, { from: BARE, text: 'stopping by at 5' })).toEqual({ reply: null });
    expect(await rStatus(id)).toBe('active');
    expect(await activeConsents(id)).toBe(1);
  });
});

describe('handleInbound HELP / other', () => {
  it('HELP names the enrolling provider and phone', async () => {
    await enroll();
    expect(await handleInbound(deps, { from: BARE, text: ' help! ' })).toEqual({
      reply: 'Pantry: free food and shelter alerts for NYC. Questions? Call 212-555-0123. Reply STOP to opt out.',
    });
  });
  it('HELP survives odd contact shapes', async () => {
    for (const c of ['Pat', 'null', '[1]', '{"phone":5}', '{}']) {
      const pid = await mkProvider('Other', c);
      await pool.query('TRUNCATE deliveries, consents, recipients CASCADE');
      await enroll(E164, pid);
      const { reply } = await handleInbound(deps, { from: BARE, text: 'HELP' });
      expect(reply).toMatch(/^Other: free food and shelter alerts for NYC\..*Reply STOP to opt out\.$/);
    }
  });
  it('HELP from unknown or bad number is generic', async () => {
    expect(await handleInbound(deps, { from: BARE, text: 'HELP' })).toEqual({ reply: GENERIC });
    expect(await handleInbound(deps, { from: 'x', text: 'HELP' })).toEqual({ reply: GENERIC });
  });
  it('other text gives null', async () => {
    expect(await handleInbound(deps, { from: BARE, text: 'thanks' })).toEqual({ reply: null });
  });
});

describe('handleStatus', () => {
  async function one(status = 'queued') {
    const id = await enroll();
    return addDelivery(id, status, 'vid');
  }
  it.each(['delivered', 'READ', 'completed'])('%s -> delivered', async (s) => {
    const d = await one();
    await handleStatus(deps, { messageId: 'vid', status: s });
    expect(await dStatus(d)).toBe('delivered');
  });
  it.each(['failed', 'rejected', 'undeliverable', 'busy', 'unanswered', 'timeout', 'Cancelled'])('%s -> failed', async (s) => {
    const d = await one();
    await handleStatus(deps, { messageId: 'vid', status: s });
    expect(await dStatus(d)).toBe('failed');
  });
  it.each(['submitted', 'started', 'ringing', 'answered', 'weird'])('%s ignored', async (s) => {
    const d = await one();
    await handleStatus(deps, { messageId: 'vid', status: s });
    expect(await dStatus(d)).toBe('queued');
  });
  it('unknown id ignored', async () => {
    await expect(handleStatus(deps, { messageId: 'nope', status: 'delivered' })).resolves.toBeUndefined();
  });
  it.each(['stopped', 'delivered', 'failed'])('never overwrites %s', async (cur) => {
    const d = await one(cur);
    await handleStatus(deps, { messageId: 'vid', status: cur === 'failed' ? 'delivered' : 'failed' });
    expect(await dStatus(d)).toBe(cur);
  });
});

describe('verifyVonageSignature', () => {
  const SECRET = 's3cret';
  const NOW = new Date('2026-06-01T16:00:00Z');
  const b64 = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  function token(body: string, o: { alg?: string; secret?: string; iat?: number; hash?: string | null } = {}) {
    const payload: Record<string, unknown> = { iat: o.iat ?? Math.floor(NOW.getTime() / 1000) };
    if (o.hash !== null) payload.payload_hash = o.hash ?? sha(body);
    const head = `${b64({ alg: o.alg ?? 'HS256', typ: 'JWT' })}.${b64(payload)}`;
    return `${head}.${createHmac('sha256', o.secret ?? SECRET).update(head).digest('base64url')}`;
  }
  const BODY = '{"a":1}';
  const t = Math.floor(NOW.getTime() / 1000);
  it('valid passes', () => expect(verifyVonageSignature(BODY, token(BODY), SECRET, NOW)).toBe(true));
  it('tampered body fails', () => expect(verifyVonageSignature('{"a":2}', token(BODY), SECRET, NOW)).toBe(false));
  it('wrong secret fails', () => expect(verifyVonageSignature(BODY, token(BODY, { secret: 'x' }), SECRET, NOW)).toBe(false));
  it('alg none fails', () => expect(verifyVonageSignature(BODY, token(BODY, { alg: 'none' }), SECRET, NOW)).toBe(false));
  it('expired iat fails', () => expect(verifyVonageSignature(BODY, token(BODY, { iat: t - 360 }), SECRET, NOW)).toBe(false));
  it('far-future iat fails', () => expect(verifyVonageSignature(BODY, token(BODY, { iat: t + 3600 }), SECRET, NOW)).toBe(false));
  it('iat within window passes', () => expect(verifyVonageSignature(BODY, token(BODY, { iat: t - 240 }), SECRET, NOW)).toBe(true));
  it('missing payload_hash fails', () => expect(verifyVonageSignature(BODY, token(BODY, { hash: null }), SECRET, NOW)).toBe(false));
  it('malformed tokens fail', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c', 'a.b.c.d', '..', `${b64('{bad')}.${b64('{bad')}.sig`]) {
      expect(verifyVonageSignature(BODY, bad, SECRET, NOW)).toBe(false);
    }
  });
  it('empty secret fails', () => expect(verifyVonageSignature(BODY, token(BODY, { secret: '' }), '', NOW)).toBe(false));
});
