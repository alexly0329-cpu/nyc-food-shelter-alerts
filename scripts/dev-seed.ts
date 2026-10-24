// Usage: DEV_SEED_PASSWORD=<10+ chars> DATABASE_URL=... PHONE_ENCRYPTION_KEY=... PHONE_HASH_KEY=... npm run seed:dev
// Creates an approved "Demo Pantry" with a staff user, an admin user and 2 enrolled test recipients. Safe to re-run: never overwrites an existing user's password. Local database only.
const pw = process.env.DEV_SEED_PASSWORD;
if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed with NODE_ENV=production');
const { assertLocalDb } = await import('./seed-guard.js');
assertLocalDb(process.env.DATABASE_URL ?? '');
if (!pw || pw.length < 10) throw new Error('DEV_SEED_PASSWORD is required and must be at least 10 characters');

// Imported after the checks so a refused run never touches config or the database.
const { getPool } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth/users.js');
const { enrollRecipient } = await import('../src/recipients/enroll.js');

const pool = getPool();
try {
  const hash = await hashPassword(pw);
  let providerId = (await pool.query(`SELECT id FROM providers WHERE name = 'Demo Pantry'`)).rows[0]?.id as string | undefined;
  providerId ??= (await pool.query(
    `INSERT INTO providers (name, address, contact, status, verified_at) VALUES ('Demo Pantry', '214 Marcy Ave, Brooklyn, NY', $1, 'approved', now()) RETURNING id`,
    [JSON.stringify({ contactName: 'Demo Staff', phone: '+17185550100', website: null })],
  )).rows[0].id as string;
  await pool.query(`UPDATE providers SET status = 'approved' WHERE id = $1`, [providerId]);
  await pool.query(
    `INSERT INTO provider_users (provider_id, email, password_hash) VALUES ($1, 'demo@example.test', $2)
     ON CONFLICT (email) DO NOTHING`,
    [providerId, hash],
  );
  await pool.query(
    `INSERT INTO provider_users (email, password_hash, role) VALUES ('admin@example.test', $1, 'admin')
     ON CONFLICT (email) DO NOTHING`,
    [hash],
  );
  const actorUserId = (await pool.query(`SELECT id FROM provider_users WHERE email = 'admin@example.test'`)).rows[0].id as string;
  const have = (await pool.query('SELECT count(*)::int AS n FROM recipients WHERE enrolled_by_provider_id = $1', [providerId])).rows[0].n as number;
  if (have < 2) {
    for (const [phone, zip] of [['(718) 555-0142', '11216'], ['(212) 555-0187', '10027']]) {
      await enrollRecipient(pool, { providerId, actorUserId, phone, channel: 'sms', language: 'en', zip, method: 'verbal', scriptConfirmed: true });
    }
  }
  console.log('Seeded: Demo Pantry (approved), demo@example.test (staff), admin@example.test (admin), 2 test recipients.');
} finally {
  await pool.end();
}
