const isTest = process.env.NODE_ENV === 'test' || !!process.env.VITEST;

// Fixed, public, test-only values. Never used outside test mode.
const TEST_DEFAULTS = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5433/alerts_test',
  PHONE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  PHONE_HASH_KEY: Buffer.alloc(32, 2).toString('base64'),
};

function env(name: keyof typeof TEST_DEFAULTS): string {
  const v = process.env[name] || (isTest ? TEST_DEFAULTS[name] : undefined);
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const encKey = env('PHONE_ENCRYPTION_KEY');
if (Buffer.from(encKey, 'base64').length !== 32) {
  throw new Error('PHONE_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
}

// Tests drop the public schema, so refuse anything but a local *_test database.
export function assertSafeTestDb(url: string): void {
  const u = new URL(url);
  const db = decodeURIComponent(u.pathname.slice(1));
  if (!['localhost', '127.0.0.1'].includes(u.hostname) || !db.endsWith('_test')) {
    throw new Error(`Refusing to wipe ${u.hostname}/${db}: need host localhost or 127.0.0.1 and a database name ending in _test`);
  }
}

const rate = process.env.VONAGE_RATE_PER_SECOND ? Number(process.env.VONAGE_RATE_PER_SECOND) : 10;
if (!Number.isInteger(rate) || rate < 1) throw new Error('VONAGE_RATE_PER_SECOND must be a positive integer');

/** MAX_ALERT_KM: optional, positive float, default 5. Message never echoes more than the var name. */
export function parseMaxAlertKm(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error('MAX_ALERT_KM must be a positive number');
  return n;
}

export const config = {
  MAX_ALERT_KM: parseMaxAlertKm(process.env.MAX_ALERT_KM),
  VONAGE_RATE_PER_SECOND: rate,
  DATABASE_URL: env('DATABASE_URL'),
  PHONE_ENCRYPTION_KEY: encKey,
  PHONE_HASH_KEY: env('PHONE_HASH_KEY'),
};
