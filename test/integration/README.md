# Integration tests

Run against a **real Neon branch**, never a mock — the schema constraints
(partial unique indexes, check constraints, cascade/`set null` FKs) are doing real
work and a mock wouldn't enforce them (M1 §7).

CI (`.github/workflows/ci.yml`) creates a throwaway Neon branch per PR, applies the
committed Drizzle migrations to it, runs `npm run test:integration`, then deletes the
branch. Locally, point `DATABASE_URL` at a scratch branch and run the same script.

Every suite here is `describe.skipIf(!process.env.DATABASE_URL)` so `npm test`
stays green locally without a database; `passWithNoTests` covers the case where
everything is skipped.

Suites: `identity.test.ts` (M2 — concurrent-register idempotency via the unique
constraint, the `where timezone = ''` set-once claim, cascade delete). The M3/M4
pair add theirs (period race, money boundary, archive eligibility).
