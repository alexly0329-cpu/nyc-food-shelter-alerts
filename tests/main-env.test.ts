import { describe, expect, it } from 'vitest';
import { missingProductionEnv } from '../src/main-env.js';

const FULL = {
  NODE_ENV: 'production', VONAGE_APPLICATION_ID: 'a', VONAGE_PRIVATE_KEY: 'k', VONAGE_NUMBER: 'n',
  VONAGE_SIGNATURE_SECRET: 's', TAVILY_API_KEY: 't',
} as NodeJS.ProcessEnv;

describe('missingProductionEnv', () => {
  it('lists every required name when production env is empty', () => {
    expect(missingProductionEnv({ NODE_ENV: 'production' })).toEqual([
      'VONAGE_APPLICATION_ID', 'VONAGE_PRIVATE_KEY', 'VONAGE_NUMBER', 'VONAGE_SIGNATURE_SECRET', 'TAVILY_API_KEY',
    ]);
  });
  it('lists only the unset (or empty) ones, names only', () => {
    const out = missingProductionEnv({ ...FULL, VONAGE_NUMBER: '', TAVILY_API_KEY: undefined });
    expect(out).toEqual(['VONAGE_NUMBER', 'TAVILY_API_KEY']);
    expect(JSON.stringify(out)).not.toContain('secret-value');
  });
  it('is empty when all set, and outside production', () => {
    expect(missingProductionEnv(FULL)).toEqual([]);
    expect(missingProductionEnv({})).toEqual([]);
    expect(missingProductionEnv({ NODE_ENV: 'development' })).toEqual([]);
  });
});
