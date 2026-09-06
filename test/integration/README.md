# Integration tests

Run against a **real Neon branch**, never a mock — the schema constraints
(partial unique indexes, check constraints, cascade/`set null` FKs) are doing real
work and a mock wouldn't enforce them (M1 §7).

CI (`.github/workflows/ci.yml`) creates a throwaway Neon branch per PR, applies the
committed Drizzle migrations to it, runs `npm run test:integration`, then deletes the
branch. Locally, point `DATABASE_URL` at a scratch branch and run the same script.

Empty this pass — `vitest` is configured with `passWithNoTests`. The first real
cases arrive with M2 (idempotent `register`/`resolve`, cascade delete) and the
M3/M4 pair (period race, money boundary, archive eligibility).
