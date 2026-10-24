// Usage: npm run summary [-- YYYY-MM-DD]   (default: today in America/New_York; needs DATABASE_URL and the two phone keys)
const arg = process.argv[2];
let day = new Date();
if (arg) {
  // Noon UTC is the same calendar day in New York (7 or 8 am).
  const d = new Date(`${arg}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arg) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== arg) {
    console.error('Usage: npm run summary [-- YYYY-MM-DD]  (a real calendar date)');
    process.exit(1);
  }
  day = d;
}

const { getPool } = await import('../src/db.js');
const { dailySummary } = await import('../src/ops/daily-summary.js');

const pool = getPool();
try {
  console.log(JSON.stringify(await dailySummary(pool, day)));
} finally {
  await pool.end();
}
