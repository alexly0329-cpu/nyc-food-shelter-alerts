import type { FastifyInstance } from 'fastify';
import { handleInbound, handleStatus, verifyVonageSignature } from '../webhooks/vonage.js';
import { HttpError, type ServerDeps } from './util.js';

const asObj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});

export function webhookRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Fail closed: no secret, no token, or a bad signature over the raw body means 401 and nothing runs.
  app.addHook('preHandler', async (req) => {
    const secret = deps.signatureSecret();
    const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!secret || !token || !verifyVonageSignature(req.rawBody ?? '', token, secret, deps.now())) {
      throw new HttpError(401, 'invalid_signature');
    }
  });

  app.post('/webhooks/vonage/inbound', async (req) => {
    const b = asObj(req.body);
    const from = typeof b.from === 'string' ? b.from : asObj(b.from).number;
    if (typeof from !== 'string' || typeof b.text !== 'string') return {};
    const { reply } = await handleInbound({ db: deps.db }, { from, text: b.text });
    if (reply) {
      try {
        await deps.sender.sendSms(from.replace(/\D/g, ''), reply);
      } catch { /* respond 200 regardless so Vonage does not retry */ }
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
