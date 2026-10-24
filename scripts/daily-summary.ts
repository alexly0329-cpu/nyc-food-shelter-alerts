// Usage: npm run summary [-- YYYY-MM-DD]   (default: today in America/New_York; needs DATABASE_URL and the two phone keys)
const arg = process.argv[2];
if (arg && !/^\d{4}-\d{2}-\d{2}$/.test(arg)) throw new Error('Usage: npm run summary [-- YYYY-MM-DD]');

const { getPool } = await import('../src/db.js');
const { dailySummary } = await import('../src/ops/daily-summary.js');

const pool = getPool();
try {
  // Noon UTC is the same calendar day in New York (7 or 8 am).
  console.log(JSON.stringify(await dailySummary(pool, arg ? new Date(`${arg}T12:00:00Z`) : new Date())));
} finally {
  await pool.end();
}
