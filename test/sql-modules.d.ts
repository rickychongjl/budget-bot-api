/**
 * Lets the integration suite import the *committed* migration SQL as strings instead
 * of keeping a hand-copied DDL block in the test. Forward-only generated SQL is the
 * source of truth (M1 §5), so a test that builds its schema from anything else can
 * drift away from what production runs.
 *
 * Vite serves `?raw` imports and expands `import.meta.glob`; only the types are
 * missing, because `tsconfig.json` deliberately loads `@cloudflare/workers-types`
 * rather than `vite/client`. Declared here to the shape `test/support/pglite-migrations.ts`
 * uses, rather than pulling in all of Vite's client types for one call.
 */
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

interface ImportMeta {
  glob<T>(
    pattern: string,
    options: { query: string; import: string; eager: true },
  ): Record<string, T>;
}
