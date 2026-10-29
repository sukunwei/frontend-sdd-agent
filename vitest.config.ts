import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * The tests run real git processes (the clone is not mocked - only its
     * invocation is counted), so a test does a few dozen process spawns.
     * Vitest's default 5 s is not enough on a loaded machine and turns into
     * a false failure.
     */
    testTimeout: 30_000,
  },
});
