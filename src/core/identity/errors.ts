/**
 * `RefusalError` now lives in `core/shared/errors.ts`.
 *
 * M2 introduced it here and noted that once M3/M8 threw the same class it belonged in
 * `core/shared` rather than inside one feature module. M3 and M4 throw it, so it
 * moved. This re-export keeps every existing M2 import — and `core/identity`'s public
 * surface — exactly as it was.
 */
export { RefusalError } from '../shared/errors';
