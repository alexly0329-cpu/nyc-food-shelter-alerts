import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { alertTotals } from '../alerts/stats.js';
import { postAlert, PostAlertError } from '../alerts/post.js';
import { requireProvider } from '../auth/session.js';
import { hashToken, login, SESSION_HOURS } from '../auth/users.js';
import { verifyProvider } from '../integrations/tavily.js';
import { applyProvider } from '../providers/apply.js';
import { enrollRecipient, EnrollError } from '../recipients/enroll.js';
import { HttpError, optOut, parse, sessionToken, type ServerDeps } from './util.js';

const applySchema = z.object({
  name: z.string(), address: z.string(), contactName: z.string(), phone: z.string(),
  website: z.string().optional(), email: z.string(), password: z.string(),
});
const loginSchema = z.object({ email: z.string(), password: z.string() });
const enrollSchema = z.object({
  phone: z.string(), channel: z.string(), language: z.string(), zip: z.string(), method: z.string(), scriptConfirmed: z.boolean(),
});
const alertSchema = z.object({
  serviceType: z.string(), address: z.string(), startsAt: z.string(), endsAt: z.string(), message: z.string(),
  capacityCap: z.number(), urgent: z.boolean().default(false), idempotencyKey: z.string().optional(),
});

const COOKIE_ATTRS = 'HttpOnly; SameSite=Lax; Path=/';

export function apiRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { db } = deps;
  const provider = (req: Parameters<typeof sessionToken>[0]) => requireProvider(db, sessionToken(req));

  app.post('/api/apply', async (req, reply) => {
    const body = parse(applySchema, req.body);
    let providerId: string;
    try {
      ({ providerId } = await applyProvider(db, body));
    } catch (e) {
      // pg errors carry a code and are real failures; plain Errors are validation or duplicate-email messages.
      if (!(e instanceof Error) || 'code' in e) throw e;
      if (e.message === 'That email is already registered') throw new HttpError(409, 'email_taken', e.message);
      throw new HttpError(400, 'invalid_input', e.message);
    }
    try {
      const result = await verifyProvider(deps.tavily, { name: body.name, address: body.address });
      await db.query('UPDATE providers SET tavily_result = $2, tavily_checked_at = now() WHERE id = $1', [providerId, JSON.stringify(result)]);
    } catch { /* a verification failure never fails the application */ }
    return reply.code(201).send({ providerId });
  });

  app.post('/api/login', async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const s = await login(db, body.email, body.password);
    if (!s) throw new HttpError(401, 'invalid_credentials');
    const secure = deps.secureCookies ? '; Secure' : '';
    reply.header('set-cookie', `session=${s.sessionToken}; ${COOKIE_ATTRS}; Max-Age=${SESSION_HOURS * 3600}${secure}`);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    const t = sessionToken(req);
    if (t) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(t)]);
    reply.header('set-cookie', `session=; ${COOKIE_ATTRS}; Max-Age=0${deps.secureCookies ? '; Secure' : ''}`);
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const t = sessionToken(req);
    const { rows } = t
      ? await db.query(
          `SELECT p.name, p.status, u.role FROM sessions s JOIN provider_users u ON u.id = s.user_id
             LEFT JOIN providers p ON p.id = u.provider_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
          [hashToken(t)],
        )
      : { rows: [] };
    if (!rows[0]) throw new HttpError(401, 'not_signed_in');
    return { providerName: rows[0].name, status: rows[0].status, role: rows[0].role };
  });

  app.post('/api/enroll', async (req, reply) => {
    const { providerId, userId } = await provider(req);
    const body = parse(enrollSchema, req.body);
    try {
      await enrollRecipient(db, { ...body, providerId, actorUserId: userId } as Parameters<typeof enrollRecipient>[1]);
    } catch (e) {
      if (e instanceof EnrollError) throw new HttpError(400, e.code, e.message);
      throw e;
    }
    return reply.code(201).send({ ok: true });
  });

  app.post('/api/optout', async (req) => optOut(db, (await provider(req)).userId, req.body));

  app.post('/api/alerts', async (req, reply) => {
    const { providerId, userId } = await provider(req);
    const body = parse(alertSchema, req.body);
    const header = req.headers['idempotency-key'];
    const idempotencyKey = body.idempotencyKey ?? (typeof header === 'string' ? header : '');
    if (!idempotencyKey.trim()) throw new HttpError(400, 'invalid_input', 'idempotencyKey required');
    try {
      const r = await postAlert(
        { db, tavily: deps.tavily, geocode: deps.geocode, enqueue: deps.enqueue, now: deps.now },
        { ...body, providerId, actorUserId: userId, idempotencyKey, serviceType: body.serviceType as 'food', startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt) },
      );
      return reply.code(201).send(r);
    } catch (e) {
      if (e instanceof PostAlertError) throw new HttpError(e.code === 'PROVIDER_NOT_APPROVED' ? 403 : 400, e.code, e.message);
      throw e;
    }
  });

  app.get('/api/alerts', async (req) => alertTotals(db, (await provider(req)).providerId));
}
