import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: {
      // db tests seed and sweep thousands of rows in one statement on a shared, loaded host, and the
      // production query deadline of 15 s (ADR 0233) cut exactly those. The deadline itself is
      // tested against a fake server in `bounded-pool.test.ts`, which passes its own values.
      DB_QUERY_TIMEOUT_MS: '120000',
    },
  },
});
