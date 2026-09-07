# Integration tests

Run against a **real Neon branch**, never a mock — the schema constraints
(partial unique indexes, check constraints, cascade/`set null` FKs) are doing real
work and a mock wouldn't enforce them (M1 §7).

CI (`.github/workflows/ci.yml`) creates a throwaway Neon branch per PR, applies the
committed Drizzle migrations to it, runs `npm run test:integration`, then deletes the
branch. Locally, point `DATABASE_URL` at a scratch branch and run the same script.

Suites here `describe.skip` themselves when `DATABASE_URL` is unset, so `npm test`
stays green locally without a database — they are skipped, never faked.

- `identity.test.ts` (M2): concurrent `register` race against the
  `(channel, external_id)` unique constraint, the conditional once-only timezone
  write, settings round-trip, check constraints, cascade delete. Cascade coverage is
  `channel_connection` only until later modules add their tables — extend the
  assertion there as they land.
- M3/M4 pair (period race, money boundary, archive eligibility) — to come.
