# Integration tests

Run against a **real Neon branch**, never a mock — the schema constraints
(partial unique indexes, check constraints, cascade/`set null` FKs) are doing real
work and a mock wouldn't enforce them (M1 §7).

CI (`.github/workflows/ci.yml`) creates a throwaway Neon branch per PR, applies the
committed Drizzle migrations to it, runs `npm run test:integration`, then deletes the
branch. Locally, point `DATABASE_URL` at a scratch branch and run the same script.

Some suites here `describe.skip` themselves when `DATABASE_URL` is unset, so
`npm test` stays green locally without a database — they are skipped, never faked.

Others run in-process on **PGlite** (real Postgres compiled to WASM), which needs no
Neon branch and therefore always runs. PGlite is a single connection, so it proves
constraints, FK behaviour and generated SQL but *not* genuine concurrency; anything
that needs two real writers belongs in a `DATABASE_URL` suite.

- `identity.test.ts` (M2): concurrent `register` race against the
  `(channel, external_id)` unique constraint, the conditional once-only timezone
  write, settings round-trip, check constraints, cascade delete. Cascade coverage is
  `channel_connection` only until later modules add their tables — extend the
  assertion there as they land.
- `parse-event-fk.test.ts` (M9/M6, PGlite): `parse_event.user_id`'s `on delete set
  null` surviving M2's cascade, plus the merchant-mapping upsert.
- `ledger-budgets.test.ts` (M3+M4, PGlite): unique and check constraints, the
  `budget_one_active_per_category` partial index, lazy period materialisation through
  the `on conflict do nothing` path, snapshot immutability across a cap change, the
  netting SQL (`expenses - refunds`, `income` excluded), keyset pagination and user
  scoping, the archive-eligibility query, cascade delete and `set null`. It builds its
  schema by executing the **committed migration files** (`?raw` imports) rather than a
  hand-copied DDL block, so it cannot drift from what a deploy applies.
