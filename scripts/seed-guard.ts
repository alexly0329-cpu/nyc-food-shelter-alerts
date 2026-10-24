/** Dev seed writes demo users with a shared password: only ever against a local database. */
export function assertLocalDb(url: string): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('Refusing to seed: DATABASE_URL is missing or not a valid URL'); }
  const overridden = [...u.searchParams.keys()].some((k) => ['host', 'hostaddr'].includes(k.toLowerCase()));
  if (!['localhost', '127.0.0.1'].includes(u.hostname) || overridden) {
    throw new Error(`Refusing to seed: DATABASE_URL host must be localhost or 127.0.0.1 (got ${u.hostname || 'none'})`);
  }
}
