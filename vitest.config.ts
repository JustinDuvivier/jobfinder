import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Mirror the tsconfig `@/*` path alias so tests can import modules that use it
  // (e.g. lib/scoring/run.ts). Additive — relative imports are unaffected.
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    // Foundation modules (db, status, path-builder) are server-side Node code.
    // UI/client tests (e.g. the diff-match-patch run) can opt into jsdom later.
    environment: 'node',
    globals: true,
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
  },
});
