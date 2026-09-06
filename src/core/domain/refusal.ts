import type { RefusalCode } from '../ports/common';

/**
 * A typed refusal (M11's refusal-code table, `RefusalCode` in `ports/common.ts`).
 *
 * Thrown by domain/service code; M7 catches it and renders `code` through the shared
 * copy table — the user never sees a raw error. `message` is a plain-language
 * explanation that M7 may show verbatim (it contains no user-supplied text unless the
 * thrower escaped it). Added by M2; M3/M8 are welcome to throw the same class so M7 has
 * exactly one thing to catch.
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
