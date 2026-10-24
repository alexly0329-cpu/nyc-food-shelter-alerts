import { describe, expect, it } from 'vitest';
import { assertLocalDb } from '../scripts/seed-guard.js';

describe('assertLocalDb (dev-seed)', () => {
  it('accepts localhost and 127.0.0.1', () => {
    expect(() => assertLocalDb('postgres://u:p@localhost:5433/alerts')).not.toThrow();
    expect(() => assertLocalDb('postgres://u:p@127.0.0.1/alerts')).not.toThrow();
  });
  it.each([
    'postgres://u:p@db.prod.example.com/alerts',
    'postgres://u:p@localhost.evil.com/alerts',
    'postgres://u:p@localhost/alerts?host=db.prod.example.com',
    'not a url',
    '',
  ])('refuses %s', (u) => {
    expect(() => assertLocalDb(u)).toThrow(/Refusing to seed/);
  });
  it('refusal does not echo credentials', () => {
    try { assertLocalDb('postgres://user:hunter2@db.prod.example.com/alerts'); } catch (e) { expect((e as Error).message).not.toContain('hunter2'); }
  });
});
