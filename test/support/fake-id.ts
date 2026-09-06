import type { Id } from '../../src/core/ports/common';

/** Monotonic, readable ids for test doubles — never used in production code. */
let nextId = 1;

export const fakeId = (prefix = 'id'): Id => `${prefix}-${String(nextId++).padStart(4, '0')}`;
