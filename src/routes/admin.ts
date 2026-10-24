import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../auth/session.js';
import { withTx } from '../db.js';
import { approveProvider, suspendProvider } from '../providers/admin.js';
import { HttpError, parse, sessionToken, type ServerDeps } from './util.js';

const idParams = z.object({ id: z.uuid() });
const providerQuery = z.object({ status: z.enum(['pending', 'approved', 'suspended']).optional() });
const alertQuery = z.object({ status: z.enum(['needs_review', 'verified', 'rejected']).default('needs_review') });

export function adminRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { db } = deps;
  const admin = (req: Parameters<typeof sessionToken>[0]) => requireAdmin(db, sessionToken(req));

  app.get('/api/admin/providers', async (req) => {
    await admin(req);
    const { status } = parse(providerQuery, req.query);
    const { rows } = await db.query(
      `SELECT id, name, address, status, tavily_result, created_at FROM providers
        WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC`,
      [status ?? null],
    );
    return rows;
  });

  for (const [action, fn] of [['approve', approveProvider], ['suspend', suspendProvider]] as const) {
    app.post(`/api/admin/providers/:id/${action}`, async (req) => {
      const { userId } = await admin(req);
      const { id } = parse(idParams, req.params);
      try {
        await fn(db, userId, id);
      } catch (e) {
        if (e instanceof Error && e.message === 'Provider not found') throw new HttpError(404, 'not_found');
        throw e;
      }
      return { ok: true };
    });
  }

  app.get('/api/admin/alerts', async (req) => {
    await admin(req);
    const { status } = parse(alertQuery, req.query);
    const { rows } = await db.query(
      `SELECT a.id, p.name AS "providerName", p.status AS "providerStatus", a.service_type AS "serviceType", a.address, a.message,
              a.starts_at AS "startsAt", a.ends_at AS "endsAt", a.capacity_cap AS "capacityCap",
              a.verification_status AS verification, (a.lat IS NOT NULL) AS geocoded
         FROM alerts a JOIN providers p ON p.id = a.provider_id
        WHERE a.verification_status = $1 ORDER BY a.created_at DESC`,
      [status],
    );
    return rows;
  });

  app.post('/api/admin/alerts/:id/approve', async (req) => {
    const { userId } = await admin(req);
    const { id } = parse(idParams, req.params);
    const found = await db.query(
      `SELECT a.address, a.lat, a.lng, p.status FROM alerts a JOIN providers p ON p.id = a.provider_id
        WHERE a.id = $1 AND a.verification_status = 'needs_review'`,
      [id],
    );
    const a = found.rows[0];
    if (!a) {
      const exists = await db.query('SELECT 1 FROM alerts WHERE id = $1', [id]);
      throw exists.rowCount ? new HttpError(409, 'not_needs_review') : new HttpError(404, 'not_found');
    }
    if (a.status !== 'approved') throw new HttpError(409, 'provider_not_approved');
    let geo = a.lat == null || a.lng == null ? await deps.geocode(a.address) : null;
    if (a.lat == null && !geo) throw new HttpError(409, 'geocode_failed', 'Address could not be located; fix the address before approving');
    // The conditional UPDATE is the gate: only one concurrent approver gets a row, so only one enqueue.
    const won = await withTx(db, async (c) => {
      const u = await c.query(
        `UPDATE alerts SET verification_status = 'verified', lat = COALESCE(lat, $2), lng = COALESCE(lng, $3)
          WHERE id = $1 AND verification_status = 'needs_review'
            AND EXISTS (SELECT 1 FROM providers p WHERE p.id = alerts.provider_id AND p.status = 'approved')
        RETURNING id`,
        [id, geo?.lat ?? null, geo?.lng ?? null],
      );
      if (!u.rowCount) return false;
      await c.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES ($1, 'alert.approve', 'alert', $2)`, [userId, id]);
      return true;
    });
    if (!won) {
      const p = await db.query(`SELECT p.status FROM alerts a JOIN providers p ON p.id = a.provider_id WHERE a.id = $1`, [id]);
      throw new HttpError(409, p.rows[0]?.status === 'approved' ? 'not_needs_review' : 'provider_not_approved');
    }
    try {
      await deps.enqueue(id, deps.now());
    } catch {
      await db.query(`UPDATE alerts SET verification_status = 'needs_review' WHERE id = $1`, [id]);
      throw new HttpError(502, 'enqueue_failed');
    }
    return { ok: true };
  });

  app.post('/api/admin/alerts/:id/reject', async (req) => {
    const { userId } = await admin(req);
    const { id } = parse(idParams, req.params);
    const won = await withTx(db, async (c) => {
      const u = await c.query(
        `UPDATE alerts SET verification_status = 'rejected' WHERE id = $1 AND verification_status = 'needs_review' RETURNING id`,
        [id],
      );
      if (!u.rowCount) return false;
      await c.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES ($1, 'alert.reject', 'alert', $2)`, [userId, id]);
      return true;
    });
    if (!won) {
      const exists = await db.query('SELECT 1 FROM alerts WHERE id = $1', [id]);
      throw exists.rowCount ? new HttpError(409, 'not_needs_review') : new HttpError(404, 'not_found');
    }
    return { ok: true };
  });
}
