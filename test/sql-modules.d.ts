/**
 * Lets the integration suite import the *committed* migration SQL as a string
 * (`import ddl from '….sql?raw'`) instead of keeping a hand-copied DDL block in the
 * test. Forward-only generated SQL is the source of truth (M1 §5), so a test that
 * builds its schema from anything else can drift away from what production runs.
 *
 * Vite serves `?raw` imports; only the type is missing.
 */
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
