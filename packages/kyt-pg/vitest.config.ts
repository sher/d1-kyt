import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.pg.test.ts'],
        },
      },
      {
        test: {
          name: 'pg',
          include: ['src/**/*.pg.test.ts'],
          globalSetup: ['test/pg-setup.ts'],
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
