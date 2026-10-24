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
      `SELECT a.id, p.name AS "providerName", a.service_type AS "serviceType", a.address, a.message,
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
    const found = await db.query(`SELECT address, lat, lng FROM alerts WHERE id = $1 AND verification_status = 'needs_review'`, [id]);
    const a = found.rows[0];
    if (!a) {
      const exists = await db.query('SELECT 1 FROM alerts WHERE id = $1', [id]);
      throw exists.rowCount ? new HttpError(409, 'not_needs_review') : new HttpError(404, 'not_found');
    }
    let geo = a.lat == null || a.lng == null ? await deps.geocode(a.address) : null;
    if (a.lat == null && !geo) throw new HttpError(409, 'geocode_failed', 'Address could not be located; fix the address before approving');
    // The conditional UPDATE is the gate: only one concurrent approver gets a row, so only one enqueue.
    const won = await withTx(db, async (c) => {
      const u = await c.query(
        `UPDATE alerts SET verification_status = 'verified', lat = COALESCE(lat, $2), lng = COALESCE(lng, $3)
          WHERE id = $1 AND verification_status = 'needs_review' RETURNING id`,
        [id, geo?.lat ?? null, geo?.lng ?? null],
      );
      if (!u.rowCount) return false;
      await c.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES ($1, 'alert.approve', 'alert', $2)`, [userId, id]);
      return true;
    });
    if (!won) throw new HttpError(409, 'not_needs_review');
    try {
      await deps.enqueue(id, deps.now());
    } catch {
      await db.query(`UPDATE alerts SET verification_status = 'needs_review' WHERE id = $1`, [id]);
      throw new HttpError(502, 'enqueue_failed');
    }
    return { ok: true };
  });
}
