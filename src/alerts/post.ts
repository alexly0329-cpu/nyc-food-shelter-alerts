import type { Pool } from 'pg';
import { verifyAlert, type TavilyLike } from '../integrations/tavily.js';

export type PostAlertErrorCode = 'INVALID_INPUT' | 'PROVIDER_NOT_APPROVED';

export class PostAlertError extends Error {
  constructor(public readonly code: PostAlertErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'PostAlertError';
  }
}

export interface PostAlertDeps {
  db: Pool;
  tavily: TavilyLike;
  geocode: (address: string) => Promise<{ lat: number; lng: number } | null>;
  enqueue: (alertId: string, runAt: Date) => Promise<void>;
  now: () => Date;
}

export interface PostAlertInput {
  providerId: string;
  serviceType: 'food' | 'shelter';
  address: string;
  startsAt: Date;
  endsAt: Date;
  message: string;
  capacityCap: number;
  urgent: boolean;
  idempotencyKey: string;
}

type Result = { alertId: string; status: 'verified' | 'needs_review' };

const validDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());
const blank = (s: unknown) => typeof s !== 'string' || s.trim() === '';

function validate(i: PostAlertInput, now: Date): void {
  const bad = (why: string): never => { throw new PostAlertError('INVALID_INPUT', why); };
  if (blank(i.message) || i.message.length > 100) bad('message must be 1-100 characters');
  if (!Number.isInteger(i.capacityCap) || i.capacityCap < 5 || i.capacityCap > 500) bad('capacityCap must be an integer 5-500');
  if (i.serviceType !== 'food' && i.serviceType !== 'shelter') bad('serviceType must be food or shelter');
  if (blank(i.address)) bad('address required');
  if (blank(i.idempotencyKey)) bad('idempotencyKey required');
  if (!validDate(i.startsAt) || !validDate(i.endsAt)) return bad('startsAt and endsAt must be valid dates');
  if (i.endsAt.getTime() <= i.startsAt.getTime()) bad('endsAt must be after startsAt');
  if (i.endsAt.getTime() <= now.getTime()) bad('endsAt must be in the future');
  // The text carries no date for a far-off start, and the alert is sent immediately.
  if (i.startsAt.getTime() > now.getTime() + 24 * 3_600_000) bad('startsAt must be within 24 hours');
}

async function findExisting(db: Pool, providerId: string, key: string): Promise<Result | null> {
  const r = await db.query('SELECT id, verification_status FROM alerts WHERE provider_id = $1 AND idempotency_key = $2', [providerId, key]);
  return r.rows[0] ? { alertId: r.rows[0].id, status: r.rows[0].verification_status } : null;
}

export async function postAlert(deps: PostAlertDeps, input: PostAlertInput): Promise<Result> {
  validate(input, deps.now());
  const { db } = deps;

  const prov = await db.query('SELECT name, status FROM providers WHERE id = $1', [input.providerId]);
  if (prov.rows[0]?.status !== 'approved') throw new PostAlertError('PROVIDER_NOT_APPROVED');

  const existing = await findExisting(db, input.providerId, input.idempotencyKey);
  if (existing) return existing;

  const geo = await deps.geocode(input.address);
  const v = await verifyAlert(deps.tavily, {
    providerName: prov.rows[0].name,
    address: input.address,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
  });
  const status = geo && v.status === 'verified' ? 'verified' : 'needs_review';

  const ins = await db.query(
    `INSERT INTO alerts (provider_id, service_type, address, lat, lng, message, starts_at, ends_at,
                         capacity_cap, urgent, verification_status, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (provider_id, idempotency_key) DO NOTHING
     RETURNING id`,
    [input.providerId, input.serviceType, input.address, geo?.lat ?? null, geo?.lng ?? null, input.message,
      input.startsAt, input.endsAt, input.capacityCap, input.urgent, status, input.idempotencyKey],
  );
  if (!ins.rows[0]) {
    // Lost the race: the winner owns the enqueue.
    const winner = await findExisting(db, input.providerId, input.idempotencyKey);
    if (!winner) throw new Error('alert vanished after idempotency conflict');
    return winner;
  }
  const alertId = ins.rows[0].id as string;

  if (status === 'verified') {
    try {
      await deps.enqueue(alertId, deps.now());
    } catch (e) {
      // No verified alert may exist without a queued job.
      await db.query("UPDATE alerts SET verification_status = 'needs_review' WHERE id = $1", [alertId]);
      throw e;
    }
  }
  return { alertId, status };
}
