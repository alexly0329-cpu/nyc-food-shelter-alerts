import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '../src/db.js';
import { postAlert, PostAlertError } from '../src/alerts/post.js';
import { mkActor } from './helpers.js';

const pool = getPool();
const NOW = new Date('2026-06-01T12:00:00Z');
const HOUR = 3_600_000;
let providerId: string;
let actorUserId: string;
let seq = 0;

const verifiedTavily = () => ({
  search: vi.fn(async () => ({
    results: [{ title: 'Test Pantry', content: 'Test Pantry at 123 Main Street, Brooklyn', url: 'https://x.test' }],
  })),
});
const emptyTavily = () => ({ search: vi.fn(async () => ({ results: [] })) });

function mk(o: { tavily?: ReturnType<typeof verifiedTavily>; geo?: { lat: number; lng: number } | null; enqueue?: () => Promise<void> } = {}) {
  const deps = {
    db: pool,
    tavily: o.tavily ?? verifiedTavily(),
    geocode: vi.fn(async () => (o.geo === undefined ? { lat: 40.7, lng: -74 } : o.geo)),
    enqueue: vi.fn(o.enqueue ?? (async () => {})),
    now: () => NOW,
  };
  return deps;
}
const input = (o: Record<string, unknown> = {}) => ({
  providerId, actorUserId,
  serviceType: 'food' as const,
  address: '123 Main St, Brooklyn, NY',
  startsAt: new Date(NOW.getTime() + HOUR),
  endsAt: new Date(NOW.getTime() + 3 * HOUR),
  message: 'Free hot meals tonight',
  capacityCap: 50,
  urgent: false,
  idempotencyKey: `k${seq++}`,
  ...o,
});
const count = async () => Number((await pool.query('SELECT count(*) FROM alerts')).rows[0].count);
const addProvider = async (status: string) =>
  (await pool.query(`INSERT INTO providers (name, address, contact, status) VALUES ('Test Pantry', '123 Main St', 'c', $1) RETURNING id`, [status]))
    .rows[0].id as string;

beforeEach(async () => {
  await pool.query('TRUNCATE deliveries, alerts, consents, recipients, provider_users, providers CASCADE');
  providerId = await addProvider('approved');
  actorUserId = await mkActor(pool);
});
afterAll(() => pool.end());

describe('postAlert validation', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['endsAt == startsAt', { endsAt: new Date(NOW.getTime() + HOUR) }],
    ['endsAt before startsAt', { endsAt: new Date(NOW.getTime()) }],
    ['endsAt in the past', { startsAt: new Date(NOW.getTime() - 3 * HOUR), endsAt: new Date(NOW.getTime() - HOUR) }],
    ['cap 4', { capacityCap: 4 }],
    ['cap 501', { capacityCap: 501 }],
    ['cap non-integer', { capacityCap: 10.5 }],
    ['101-char message', { message: 'x'.repeat(101) }],
    ['empty message', { message: '' }],
    ['blank address', { address: '  ' }],
    ['empty key', { idempotencyKey: '' }],
    ['bad serviceType', { serviceType: 'pizza' }],
    ['invalid date', { startsAt: new Date('nope') }],
  ];
  it.each(bad)('rejects %s', async (_n, o) => {
    const deps = mk();
    await expect(postAlert(deps, input(o) as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await count()).toBe(0);
    expect(deps.tavily.search).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
  it('accepts 100-char message and caps 5 and 500', async () => {
    for (const o of [{ message: 'x'.repeat(100) }, { capacityCap: 5 }, { capacityCap: 500 }]) {
      await expect(postAlert(mk(), input(o))).resolves.toMatchObject({ status: 'verified' });
    }
  });
  it('rejects startsAt more than 24 hours ahead with a static message', async () => {
    const deps = mk();
    const startsAt = new Date(NOW.getTime() + 25 * HOUR);
    await expect(postAlert(deps, input({ startsAt, endsAt: new Date(startsAt.getTime() + HOUR) }))).rejects.toMatchObject({
      code: 'INVALID_INPUT', message: 'startsAt must be within 24 hours',
    });
    expect(await count()).toBe(0);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
  it('accepts startsAt 23 hours ahead and a startsAt in the past', async () => {
    const ahead = new Date(NOW.getTime() + 23 * HOUR);
    await expect(postAlert(mk(), input({ startsAt: ahead, endsAt: new Date(ahead.getTime() + HOUR) }))).resolves.toMatchObject({ status: 'verified' });
    await expect(postAlert(mk(), input({ startsAt: new Date(NOW.getTime() - HOUR) }))).resolves.toMatchObject({ status: 'verified' });
  });
  it('error is a PostAlertError', async () => {
    await expect(postAlert(mk(), input({ capacityCap: 4 }))).rejects.toBeInstanceOf(PostAlertError);
  });
});

describe('postAlert', () => {
  it('verified: stores lat/lng, enqueues once at now', async () => {
    const deps = mk();
    const r = await postAlert(deps, input());
    expect(r.status).toBe('verified');
    const row = (await pool.query('SELECT * FROM alerts WHERE id = $1', [r.alertId])).rows[0];
    expect(row).toMatchObject({ verification_status: 'verified', lat: 40.7, lng: -74, capacity_cap: 50, urgent: false });
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.enqueue).toHaveBeenCalledWith(r.alertId, NOW);
  });

  it('tavily needs_review: stored, no enqueue', async () => {
    const deps = mk({ tavily: emptyTavily() });
    const r = await postAlert(deps, input());
    expect(r.status).toBe('needs_review');
    const row = (await pool.query('SELECT * FROM alerts WHERE id = $1', [r.alertId])).rows[0];
    expect(row.verification_status).toBe('needs_review');
    expect(row.lat).toBe(40.7);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('geocode null: needs_review with null coordinates, no enqueue', async () => {
    const deps = mk({ geo: null });
    const r = await postAlert(deps, input());
    expect(r.status).toBe('needs_review');
    const row = (await pool.query('SELECT * FROM alerts WHERE id = $1', [r.alertId])).rows[0];
    expect(row).toMatchObject({ verification_status: 'needs_review', lat: null, lng: null });
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('same idempotencyKey twice: one row, one enqueue, no second external call', async () => {
    const deps = mk();
    const i = input();
    const a = await postAlert(deps, i);
    const b = await postAlert(deps, i);
    expect(b).toEqual(a);
    expect(await count()).toBe(1);
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.geocode).toHaveBeenCalledTimes(1);
    expect(deps.tavily.search).toHaveBeenCalledTimes(1);
  });

  it('two parallel same-key calls: one row, one enqueue', async () => {
    const deps = mk();
    const i = input();
    const [a, b] = await Promise.all([postAlert(deps, i), postAlert(deps, i)]);
    expect(a.alertId).toBe(b.alertId);
    expect(await count()).toBe(1);
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each(['pending', 'suspended'])('%s provider: PROVIDER_NOT_APPROVED, nothing inserted', async (status) => {
    const id = await addProvider(status);
    const deps = mk();
    await expect(postAlert(deps, input({ providerId: id }))).rejects.toMatchObject({ code: 'PROVIDER_NOT_APPROVED' });
    expect(await count()).toBe(0);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('unknown provider: PROVIDER_NOT_APPROVED', async () => {
    await expect(
      postAlert(mk(), input({ providerId: '00000000-0000-0000-0000-000000000000' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_APPROVED' });
  });

  it('enqueue throws: alert left needs_review, error rethrown', async () => {
    const deps = mk({ enqueue: async () => { throw new Error('queue down'); } });
    await expect(postAlert(deps, input())).rejects.toThrow('queue down');
    const rows = (await pool.query('SELECT verification_status FROM alerts')).rows;
    expect(rows).toEqual([{ verification_status: 'needs_review' }]);
  });
});

describe('postAlert auto-supersede of stale needs_review alerts', () => {
  const old = async (pid: string, o: { address?: string; startH?: number; endH?: number; status?: string } = {}) =>
    (await pool.query(
      `INSERT INTO alerts (provider_id, service_type, address, lat, lng, message, starts_at, ends_at, capacity_cap, idempotency_key, verification_status)
       VALUES ($1, 'food', $2, 40.7, -74, 'm', $3, $4, 10, $5, $6) RETURNING id`,
      [pid, o.address ?? '123 Main St, Brooklyn, NY', new Date(NOW.getTime() + (o.startH ?? 2) * HOUR),
        new Date(NOW.getTime() + (o.endH ?? 4) * HOUR), `old${seq++}`, o.status ?? 'needs_review'],
    )).rows[0].id as string;
  const st = async (id: string) => (await pool.query('SELECT verification_status FROM alerts WHERE id = $1', [id])).rows[0].verification_status as string;

  it('rejects the same provider\'s overlapping same-address needs_review alert (case/space-insensitive)', async () => {
    const stale = await old(providerId, { address: '  123 main st, BROOKLYN, ny ' });
    await postAlert(mk(), input());
    expect(await st(stale)).toBe('rejected');
  });
  it('leaves other address, non-overlapping window, adjacent window, other provider and non-held alerts untouched', async () => {
    const other = await addProvider('approved');
    const ids = {
      addr: await old(providerId, { address: '9 Other St, Brooklyn, NY' }),
      later: await old(providerId, { startH: 4, endH: 5 }),
      adjacent: await old(providerId, { startH: -1, endH: 1 }), // ends exactly when the new one starts
      otherProv: await old(other),
      verified: await old(providerId, { status: 'verified' }),
    };
    await postAlert(mk(), input());
    for (const [k, id] of Object.entries(ids)) expect(await st(id), k).toBe(k === 'verified' ? 'verified' : 'needs_review');
  });
  it('a new needs_review alert supersedes nothing', async () => {
    const stale = await old(providerId);
    await postAlert(mk({ tavily: emptyTavily() }), input());
    expect(await st(stale)).toBe('needs_review');
  });
  it('a cleanup failure never fails the post', async () => {
    const stale = await old(providerId);
    const real = pool.query.bind(pool);
    const spy = vi.spyOn(pool, 'query').mockImplementation(((q: unknown, ...rest: unknown[]) =>
      typeof q === 'string' && q.includes("SET verification_status = 'rejected'") ? Promise.reject(new Error('boom')) : (real as (...a: unknown[]) => unknown)(q, ...rest)) as never);
    try {
      await expect(postAlert(mk(), input())).resolves.toMatchObject({ status: 'verified' });
    } finally { spy.mockRestore(); }
    expect(await st(stale)).toBe('needs_review');
  });
});


describe('postAlert audit', () => {
  const audit = async () => (await pool.query(`SELECT actor_id, action, target_type, target_id FROM audit_log WHERE action = 'alert.post'`)).rows;

  it.each([['verified', undefined], ['needs_review', null]] as const)('writes alert.post (ids only) for a %s alert', async (_s, geo) => {
    const r = await postAlert(mk({ geo }), input());
    expect(await audit()).toEqual([{ actor_id: actorUserId, action: 'alert.post', target_type: 'alert', target_id: r.alertId }]);
  });
  it('an idempotent replay writes no second audit row', async () => {
    const i = input();
    await postAlert(mk(), i);
    await postAlert(mk(), i);
    expect(await audit()).toHaveLength(1);
  });
  it('a failed audit insert leaves no alert row', async () => {
    await expect(postAlert(mk(), input({ actorUserId: '00000000-0000-4000-8000-000000000000' }))).rejects.toThrow();
    expect(await count()).toBe(0);
  });
});
