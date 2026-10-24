import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { z } from 'zod';
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
