/**
 * `core/shared` — genuinely shared domain concepts, not a second dumping ground
 * (CLAUDE.md, "Shared domain code"). Feature-specific calculations belong with
 * their owning feature.
 *
 * `money.ts` qualifies: money is `bigint` minor units everywhere, and every module
 * that touches an amount needs the same conversion and the same scale rules.
 *
 * `common.ts` and `clock.ts` are still under `core/ports/` — every module (including
 * untouched stubs) imports them from there, so relocating them is a repo-wide
 * refactor of its own rather than part of M6's PR. See `docs/build-log.md`.
 */
export * from './money';
