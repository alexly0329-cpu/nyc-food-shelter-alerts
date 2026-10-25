import type { Pool } from 'pg';

export interface AlertTotals {
  alertId: string;
  title: string;
  address: string;
  serviceType: string;
  status: string;
  verification: string;
  hoursCheck: string;
  startsAt: Date;
  endsAt: Date;
  capacityCap: number;
  texted: number;
  delivered: number;
  failed: number;
  stopped: number;
}

/** Per-alert delivery totals for one provider. Counts only: never recipient ids or numbers. */
export async function alertTotals(db: Pool, providerId: string): Promise<AlertTotals[]> {
  const { rows } = await db.query(
    `SELECT a.id AS "alertId", a.message AS title, a.address, a.service_type AS "serviceType",
            a.send_state AS status, a.verification_status AS verification, a.hours_check AS "hoursCheck",
            a.starts_at AS "startsAt", a.ends_at AS "endsAt", a.capacity_cap AS "capacityCap",
            (count(d.id) FILTER (WHERE d.claimed_at IS NOT NULL OR d.vonage_id IS NOT NULL))::int AS texted,
            (count(d.id) FILTER (WHERE d.status = 'delivered'))::int AS delivered,
            (count(d.id) FILTER (WHERE d.status = 'failed'))::int AS failed,
            (count(d.id) FILTER (WHERE d.status = 'stopped'))::int AS stopped
       FROM alerts a LEFT JOIN deliveries d ON d.alert_id = a.id
      WHERE a.provider_id = $1
      GROUP BY a.id
      ORDER BY a.created_at DESC, a.id`,
    [providerId],
  );
  return rows;
}
