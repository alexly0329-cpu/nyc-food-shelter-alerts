import type pg from 'pg';
import { z } from 'zod';
import { EMAIL_RE, hashPassword, MAX_PASSWORD } from '../auth/users.js';
import { withTx } from '../db.js';
import { normalizePhone } from '../phone.js';

const nonEmpty = (field: string) => z.string().trim().min(1, `${field} is required`);
const schema = z.object({
  name: nonEmpty('name'),
  address: nonEmpty('address'),
  contactName: nonEmpty('contactName'),
  phone: z.string().transform((s, ctx) => {
    const p = normalizePhone(s);
    if (!p) ctx.addIssue({ code: 'custom', message: 'phone is not a valid US number' });
    return p as string;
  }),
  website: z.string().trim().optional(),
  email: z.string().trim().toLowerCase().regex(EMAIL_RE, 'email is invalid'),
  password: z.string().min(10, 'password must be at least 10 characters').max(MAX_PASSWORD, `password must be at most ${MAX_PASSWORD} characters`),
});

/** Messages are fixed or validation texts; safe to show to the applicant. */
export class ApplyError extends Error {
  constructor(public readonly code: 'EMAIL_TAKEN' | 'INVALID_INPUT', message: string) {
    super(message);
    this.name = 'ApplyError';
  }
}

export type ApplyInput = z.input<typeof schema>;

export async function applyProvider(db: pg.Pool, input: ApplyInput): Promise<{ providerId: string }> {
  const r = schema.safeParse(input);
  if (!r.success) throw new ApplyError('INVALID_INPUT', r.error.issues.map((i) => i.message).join('; '));
  const v = r.data;
  const passwordHash = await hashPassword(v.password);
  try {
    return await withTx(db, async (c) => {
      const p = await c.query(`INSERT INTO providers (name, address, contact) VALUES ($1, $2, $3) RETURNING id`, [
        v.name,
        v.address,
        JSON.stringify({ contactName: v.contactName, phone: v.phone, website: v.website || null }),
      ]);
      await c.query(`INSERT INTO provider_users (provider_id, email, password_hash) VALUES ($1, $2, $3)`, [
        p.rows[0].id,
        v.email,
        passwordHash,
      ]);
      return { providerId: p.rows[0].id as string };
    });
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ApplyError('EMAIL_TAKEN', 'That email is already registered');
    throw e;
  }
}
