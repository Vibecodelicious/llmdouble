// Types for `toPass()` in this repo's own vitest suites. A `.d.ts` under src/ is
// typechecked but not emitted, so nothing in dist/ refers to vitest; a consumer
// adds the same three lines (or the jest / bun:test equivalent) to its own tests.
export {};

declare module 'vitest' {
  interface Assertion<T = unknown> {
    /** The received value is a `Verdict` with status PASS. FAIL and BLOCKED fail; BLOCKED fails under `.not` too. */
    toPass(): T;
  }
}
