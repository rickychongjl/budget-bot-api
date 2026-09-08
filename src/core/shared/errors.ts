import type { RefusalCode } from './common';

/**
 * A typed refusal (M11's refusal-code table, `RefusalCode` in `./common.ts`).
 *
 * Thrown by domain/service code; M7 catches it and renders `code` through the shared
 * copy table — the user never sees a raw error. `message` is a plain-language
 * explanation M7 may show verbatim (it contains no user-supplied text unless the
 * thrower escaped it).
 *
 * Added by M2 in `core/identity/errors.ts`, which said: "M3/M8 are welcome to throw
 * the same class so M7 has exactly one thing to catch — at which point it belongs in
 * `core/shared`, not here." M3 and M4 are those modules, so it moved here.
 * `core/identity/errors.ts` re-exports it, and `core/identity`'s public surface is
 * unchanged.
 *
 * M8's `EntitlementRefusal` stays separate on purpose — it carries a `retryAt` this
 * class has no use for, and M7 catches both.
 */
export class RefusalError extends Error {
  override readonly name = 'RefusalError';

  constructor(
    readonly code: RefusalCode,
    message?: string,
  ) {
    super(message ?? code);
  }

  static is(value: unknown, code?: RefusalCode): value is RefusalError {
    return value instanceof RefusalError && (code === undefined || value.code === code);
  }
}
