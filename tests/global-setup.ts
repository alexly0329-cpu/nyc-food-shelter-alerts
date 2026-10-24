import pg from 'pg';
import { migrate } from '../src/db.js';
import { assertSafeTestDb, config } from '../src/config.js';

export default async function setup() {
  assertSafeTestDb(config.DATABASE_URL);
  // All runs share one Postgres. A second `vitest run` would DROP SCHEMA and TRUNCATE under the first (random
  // timeouts and FK errors), so hold a session-level advisory lock for the whole run: later runs wait here.
  const lock = new pg.Client({ connectionString: config.DATABASE_URL });
  await lock.connect();
  await lock.query('SELECT pg_advisory_lock(7283003)');
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await migrate(pool);
  } finally {
    await pool.end();
  }
  return async () => {
    await lock.end(); // closing the session releases the lock
  };
}
