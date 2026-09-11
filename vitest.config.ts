import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Test tiers (M1 §7):
 *   - unit        `test/unit/**`        — pure `core/domain` logic, no DB, no Worker.
 *   - integration `test/integration/**` — against a real Neon branch (constraints do real work).
 *   - eval        M6's versioned NLP set — added with M6.
 *   - e2e         deliberately manual. M7 4B's plan settled this: production is the
 *                 only environment (master plan §5.7), so there is no staging Worker
 *                 to point an automated round trip at. Stage 4E's checklist — a real
 *                 `/internal/send-allowance` and a real `/start` against Ricky's own
 *                 chat — is the e2e tier for this pass.
 *
 * `passWithNoTests` keeps CI green while the integration/eval suites are still empty.
 */

/**
 * `tsconfig.json` sets `types: ["@cloudflare/workers-types"]` on purpose — nothing in
 * this repo should see Node's globals. `ImportMeta.url` is real at runtime (this file
 * is loaded by Vite as ESM); it is only the *type* that is missing, so declare it here
 * rather than pulling in `@types/node` for one property.
 */
declare global {
  interface ImportMeta {
    readonly url: string;
  }
}

/**
 * The directory holding this config file, resolved without `node:path`/`node:url`.
 *
 * Deliberately NOT `process.cwd()`: the VS Code Vitest extension's debug path spawns
 * its runner through `vscode-js-debug` with a different cwd than its run path, so a
 * cwd-relative lookup found `.env` on Run and missed it on Debug — silently turning
 * the integration suite's `DATABASE_URL` gate into a skip rather than an error. The
 * same trap catches `npm --prefix` and running this worktree's suite from the repo
 * root. `import.meta.url` is fixed at this file's location, so every launcher agrees.
 *
 * `pathname` is percent-encoded and, on Windows, carries a leading slash before the
 * drive letter (`/C:/...`); both are undone here. On POSIX the replace is a no-op.
 */
const configDir = decodeURIComponent(new URL('.', import.meta.url).pathname).replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

export default defineConfig(({ mode }) => ({
  test: {
    passWithNoTests: true,
    // Loads `.env`/`.env.local` into process.env so `DATABASE_URL` reaches the
    // integration suite's `describe.skip` gate without a manual export. CI sets
    // the variable itself, so this is a local-dev convenience only.
    env: loadEnv(mode, configDir, ''),

    /**
     * Split into projects so the two tiers can have different parallelism. There is
     * no `include` at this level on purpose — with `projects`, a root-level `include`
     * collects every file a second time and each test runs twice.
     *
     * Integration files run one at a time; unit files stay parallel. Every
     * integration suite shares one Neon database and some assert on table-wide state
     * (M2 counts `app_user` rows that have no `channel_connection`). Run in parallel,
     * one suite's fixtures are visible to another's queries — M8's `beforeAll` user
     * has no connection row, so M2 counted it as an orphan and failed. Setting this
     * here rather than only in the `test:integration` script means a plain
     * `npm test` gets the same guarantee.
     */
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
}));
