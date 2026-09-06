import type { RefusalCode } from '../ports/common';

/**
 * The typed refusal M2 throws. M7 renders `code` via M11's refusal-code table and
 * never shows `message` raw (it's for logs and tests). Mirrors the "throws a typed
 * refusal" convention `EntitlementService.assertAllowed` already uses.
 */
export class IdentityError extends Error {
  override readonly name: string = 'IdentityError';

  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
  }
}

export function isIdentityError(error: unknown, code?: RefusalCode): error is IdentityError {
  return error instanceof IdentityError && (code === undefined || error.code === code);
}
