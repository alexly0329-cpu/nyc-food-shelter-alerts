import type { FastifyInstance } from 'fastify';
import { logEvent } from '../ops/log.js';
import { handleInbound, handleStatus, verifyVonageSignature } from '../webhooks/vonage.js';
import { HttpError, type ServerDeps } from './util.js';

const asObj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});

export function webhookRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Fail closed: no secret, no token, or a bad signature over the raw body means 401 and nothing runs.
  app.addHook('preHandler', async (req) => {
    const secret = deps.signatureSecret();
    const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!secret || !token || !verifyVonageSignature(req.rawBody ?? '', token, secret, deps.now())) {
      logEvent('webhook_rejected', { route: req.routeOptions?.url ?? 'unknown', reason: 'invalid_signature' });
      throw new HttpError(401, 'invalid_signature');
    }
  });

  // Unexpected exceptions only (HttpError is a deliberate client error). Error name, never its message.
  app.addHook('onError', async (req, _reply, err) => {
    if (!(err instanceof HttpError)) logEvent('webhook_error', { route: req.routeOptions?.url ?? 'unknown', reason: err.name });
  });

  app.post('/webhooks/vonage/inbound', async (req) => {
    const b = asObj(req.body);
    const from = typeof b.from === 'string' ? b.from : asObj(b.from).number;
    if (typeof from !== 'string' || typeof b.text !== 'string') return {};
    const { reply } = await handleInbound({ db: deps.db }, { from, text: b.text });
    if (reply) {
      try {
        await deps.sender.sendSms(from.replace(/\D/g, ''), reply);
      } catch {
        // Respond 200 regardless so Vonage does not retry; no error text (it could carry the number).
        logEvent('send_failed', { channel: 'sms', reason: 'reply_failed' });
      }
    }
    return {};
  });

  app.post('/webhooks/vonage/status', async (req) => {
    const b = asObj(req.body);
    const id = b.message_uuid ?? b.uuid;
    if (typeof id === 'string' && typeof b.status === 'string') await handleStatus({ db: deps.db }, { messageId: id, status: b.status });
    return {};
  });
}
