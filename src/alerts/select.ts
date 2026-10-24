import type pg from 'pg';
import { decryptPhone } from '../crypto.js';

export type SelectedRecipient = { id: string; channel: 'sms' | 'voice'; language: string; phone: string };

// Haversine (R = 6371 km) in SQL; LEAST clamps so rounding cannot push sqrt/asin out of domain.
// $1 = lat, $2 = lng, $3 = cap, $4 = now (injected; never the DB clock).
const SQL = `
SELECT r.id, r.channel, r.language, r.phone
FROM recipients r
WHERE r.status = 'active'
  AND EXISTS (SELECT 1 FROM consents c WHERE c.recipient_id = r.id AND c.revoked_at IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM deliveries d
    WHERE d.recipient_id = r.id AND d.created_at > $4::timestamptz - interval '24 hours'
  )
ORDER BY 2 * 6371 * asin(sqrt(LEAST(1.0, GREATEST(0.0,
    power(sin(radians(r.lat - $1::float8) / 2), 2) +
    cos(radians($1::float8)) * cos(radians(r.lat)) * power(sin(radians(r.lng - $2::float8) / 2), 2)
  )))) ASC, r.id ASC
LIMIT $3::int`;

export async function selectRecipients(
  db: pg.Pool | pg.PoolClient,
  input: { lat: number; lng: number; cap: number; now: Date },
): Promise<SelectedRecipient[]> {
  const { lat, lng, cap, now } = input;
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`cap must be a positive integer, got ${cap}`);
  if (!Number.isFinite(lat)) throw new Error(`lat must be a finite number, got ${lat}`);
  if (!Number.isFinite(lng)) throw new Error(`lng must be a finite number, got ${lng}`);
  const { rows } = await db.query(SQL, [lat, lng, cap, now]);
  return rows.map((r) => ({ id: r.id, channel: r.channel, language: r.language, phone: decryptPhone(r.phone) }));
}
