// Usage: ADMIN_PASSWORD=<10-256 chars> DATABASE_URL=... PHONE_ENCRYPTION_KEY=... PHONE_HASH_KEY=... npm run create-admin -- you@example.org
// Creates the first admin (approves providers and held alerts). Refuses if the email already exists; never prints the password.
const email = process.argv[2];
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) {
  console.error('Usage: ADMIN_PASSWORD=... npm run create-admin -- <email>   (ADMIN_PASSWORD is required)');
  process.exit(1);
}

// Imported after the checks so a refused run never touches config or the database.
const { getPool } = await import('../src/db.js');
const { createAdmin } = await import('../src/auth/users.js');

const pool = getPool();
let code = 0;
try {
  await createAdmin(pool, email, password);
  console.log(`Created admin ${email.trim().toLowerCase()}.`);
} catch (e) {
  console.error(`Failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  code = 1;
} finally {
  await pool.end();
}
process.exit(code);
