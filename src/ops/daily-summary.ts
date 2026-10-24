import type { Pool } from 'pg';

const TZ = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' });
const parts = (d: Date) => Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, Number(p.value)]));

/** Local midnight of the given calendar date (month 1-12; day may overflow) in New York, as an instant. */
function midnight(y: number, m: number, d: number): Date {
  const base = Date.UTC(y, m - 1, d);
  // Midnight is never skipped by DST (it happens at 2 am), so exactly one of the two offsets lands on hour 0.
  for (const off of [4, 5]) {
    const c = new Date(base + off * 3_600_000);
    const p = parts(c);
    if (p.hour === 0 && p.day === new Date(base).getUTCDate()) return c;
  }
  throw new Error('unreachable: no New York midnight found');
}

/** [start, end) of the America/New_York calendar day containing `day`. 23 or 25 hours on DST days. */
export function dayWindow(day: Date): { start: Date; end: Date } {
  const { year, month, day: d } = parts(day);
  return { start: midnight(year, month, d), end: midnight(year, month, d + 1) };
}

export interface DailySummary {
  alerts: number; sent: number; delivered: number; failed: number; stopped: number; deliveryRate: number;
}

/** Counts only. `sent` = attempted (claimed or has a Vonage id), same meaning as `texted` in alerts/stats.ts. */
export async function dailySummary(db: Pool, day: Date): Promise<DailySummary> {
  const { start, end } = dayWindow(day);
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM alerts WHERE created_at >= $1 AND created_at < $2)::int AS alerts,
            count(*) FILTER (WHERE claimed_at IS NOT NULL OR vonage_id IS NOT NULL)::int AS sent,
            count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'stopped')::int AS stopped
       FROM deliveries WHERE created_at >= $1 AND created_at < $2`,
    [start, end],
  );
  const r = rows[0];
  return { ...r, deliveryRate: r.sent === 0 ? 0 : r.delivered / r.sent };
}
