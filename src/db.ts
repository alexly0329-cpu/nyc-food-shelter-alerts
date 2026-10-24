import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  return (pool ??= new pg.Pool({ connectionString: config.DATABASE_URL }));
}

export async function withTx<T>(p: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function migrate(p: pg.Pool): Promise<void> {
  await p.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await withTx(p, async (c) => {
      // advisory lock serializes concurrent migrators
      await c.query('SELECT pg_advisory_xact_lock(7283001)');
      const done = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
      if (done.rowCount) return;
      await c.query(readFileSync(MIGRATIONS_DIR + f, 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
  }
}
