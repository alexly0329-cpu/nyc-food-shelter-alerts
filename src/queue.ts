import { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import { runSendJob, type SendJobDeps, type Sender } from './alerts/send.js';
import { config } from './config.js';
import { logEvent } from './ops/log.js';

const QUEUE = 'send-alert';

/** The slice of PgBoss used here, so tests can pass a fake. */
export interface BossLike {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  createQueue(name: string): Promise<void>;
  send(name: string, data: object, options: { startAfter: Date; retryLimit: number; retryDelay: number; retryBackoff: boolean }): Promise<string | null>;
  work(name: string, options: { localConcurrency: number }, handler: (jobs: Array<{ data: { alertId: string } }>) => Promise<void>): Promise<string>;
  on(event: 'error', fn: (e: Error) => void): unknown;
}

export interface QueueDeps {
  pool: Pool;
  sender: Sender;
  now?: () => Date;
  sleep?: SendJobDeps['sleep'];
}

export function createQueue(deps: QueueDeps, boss: BossLike = new PgBoss(config.DATABASE_URL) as unknown as BossLike) {
  const enqueue = async (alertId: string, runAt: Date): Promise<void> => {
    // A retry is safe: runSendJob is idempotent (claim columns, at-most-once per delivery).
    await boss.send(QUEUE, { alertId }, { startAfter: runAt, retryLimit: 3, retryDelay: 30, retryBackoff: true });
  };
  boss.on('error', (e) => logEvent('queue_error', { reason: e.message }));
  return {
    enqueue,
    async start() {
      await boss.start();
      await boss.createQueue(QUEUE); // idempotent; required before send/work
      await boss.work(QUEUE, { localConcurrency: 1 }, async (jobs) => {
        for (const j of jobs) {
          try {
            await runSendJob({ db: deps.pool, sender: deps.sender, enqueue, now: deps.now ?? (() => new Date()), sleep: deps.sleep }, j.data.alertId);
          } catch (e) {
            logEvent('queue_error', { alertId: j.data.alertId, reason: e instanceof Error ? e.message : 'unknown' });
            throw e; // pg-boss retries
          }
        }
      });
    },
    stop: () => boss.stop(),
  };
}
