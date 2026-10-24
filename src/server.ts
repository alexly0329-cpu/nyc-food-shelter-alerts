import Fastify, { type FastifyInstance } from 'fastify';
import { AuthError } from './auth/session.js';
import { adminRoutes } from './routes/admin.js';
import { apiRoutes } from './routes/api.js';
import { HttpError, type ServerDeps } from './routes/util.js';
import { webhookRoutes } from './routes/webhooks.js';

export type { ServerDeps };

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.VITEST ? 'silent' : 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body', 'res.headers["set-cookie"]'],
    },
    bodyLimit: 100_000,
  });

  // Keep the raw string for webhook signature checks. Malformed JSON becomes an undefined body,
  // which route validation rejects (400) and webhooks reject first on signature (401).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = body as string;
    req.rawBody = raw;
    try {
      done(null, raw === '' ? {} : JSON.parse(raw));
    } catch {
      done(null, undefined);
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('x-content-type-options', 'nosniff').header('cache-control', 'no-store');
    // Simple CSRF defense next to SameSite=Lax: a cross-site form cannot send this content type.
    if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return reply.code(415).send({ error: 'unsupported_media_type' });
    }
  });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error;
    if (err instanceof HttpError) return reply.code(err.status).send(err.detail ? { error: err.code, message: err.detail } : { error: err.code });
    if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) return reply.code(status).send({ error: 'bad_request' });
    req.log.error({ err: { type: err.name } }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  apiRoutes(app, deps);
  adminRoutes(app, deps);
  app.register(async (hooks) => webhookRoutes(hooks, deps));
  return app;
}
