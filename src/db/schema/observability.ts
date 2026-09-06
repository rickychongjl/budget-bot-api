/**
 * M9 — Observability, Privacy & Retention owns this file.
 * Built as part of M6's PR this pass (M9 is otherwise a deliberate stub).
 *
 * Tables: `parse_event`.
 *
 * Conventions: see `identity.ts` header. Specifics from M9/M6's plans:
 *   - `user_id` -> `app_user(id) on delete set null` — this is the ONE row that
 *     survives account deletion (test that the FK actually nulls, M9 checklist).
 *   - `route text check (route in ('command','mechanical','mapping','llm'))`.
 *   - Holds routes, token counts, latencies, booleans ONLY. No message text, ever,
 *     under any route. That is what makes `user_id` safely nullable.
 *   - `was_corrected` is written later by M3's `correct` — a cross-module callback.
 *   - Index `(created_at)`.
 */
export {};
