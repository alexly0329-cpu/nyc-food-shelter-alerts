import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/global-setup.ts'],
    // all files share one Postgres; truncating in parallel would collide
    fileParallelism: false,
  },
});
