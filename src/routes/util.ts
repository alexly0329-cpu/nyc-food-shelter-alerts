import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { normalizePhone } from '../phone.js';
import { stopRecipient } from '../recipients/revoke.js';
import type { Sender } from '../alerts/send.js';
import type { TavilyLike } from '../integrations/tavily.js';

export interface ServerDeps {
  db: Pool;
  tavily: TavilyLike;
  geocode: (address: string) => Promise<{ lat: number; lng: number } | null>;
  sender: Sender;
  enqueue: (alertId: string, runAt: Date) => Promise<void>;
  now: () => Date;
  signatureSecret: () => string | undefined;
  secureCookies: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/** Thrown for any client error; the message must never contain secrets, phones or message bodies. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, public detail?: string) {
    super(code);
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'invalid_input', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

export function sessionToken(req: FastifyRequest): string | undefined {
  const m = /(?:^|;\s*)session=([0-9a-f]+)/.exec(req.headers.cookie ?? '');
  return m?.[1];
}

export const optoutSchema = z.object({ phone: z.string() });

/** Shared by the staff and admin opt-out routes. Same answer whether or not the number is enrolled. */
export async function optOut(db: Pool, actorUserId: string, body: unknown): Promise<{ ok: true }> {
  const phone = normalizePhone(parse(optoutSchema, body).phone);
  if (!phone) throw new HttpError(400, 'INVALID_PHONE');
  await stopRecipient(db, phone, actorUserId);
  return { ok: true };
}
