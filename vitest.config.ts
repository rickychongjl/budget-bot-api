import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Test tiers (M1 §7):
 *   - unit        `test/unit/**`        — pure `core/domain` logic, no DB, no Worker.
 *   - integration `test/integration/**` — against a real Neon branch (constraints do real work).
 *   - eval        M6's versioned NLP set — added with M6.
 *   - e2e         one deployed-Worker webhook round trip — added with M7.
 *
 * `passWithNoTests` keeps CI green while the integration/eval suites are still empty.
 */
export default defineConfig(({ mode }) => ({
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    // Loads `.env`/`.env.local` into process.env so `DATABASE_URL` reaches the
    // integration suite's `describe.skip` gate without a manual export. CI sets
    // the variable itself, so this is a local-dev convenience only.
    env: loadEnv(mode, process.cwd(), ''),
  },
}));
