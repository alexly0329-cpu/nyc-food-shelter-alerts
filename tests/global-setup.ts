import pg from 'pg';
import { migrate } from '../src/db.js';
import { assertSafeTestDb, config } from '../src/config.js';

export default async function setup() {
  assertSafeTestDb(config.DATABASE_URL);
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
