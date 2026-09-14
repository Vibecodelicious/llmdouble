// `toPass()` (epic C4): the one runner integration, in the `expect.extend`
// protocol vitest, jest, and bun:test share. PASS passes; FAIL fails with the
// claim and evidence; BLOCKED fails with a message beginning `BLOCKED:`.
//
// BLOCKED fails in both polarities: `expect(v).not.toPass()` on a BLOCKED
// verdict also fails, so a negative control whose instrument broke cannot
// read as "correctly did not pass".
//
//   import { matchers } from 'llmdouble';
//   expect.extend(matchers);
//   expect(rec.last.doesNotContain(secret)).toPass();

import { isVerdict } from './verdict.js';

export interface MatcherResult {
  pass: boolean;
  message: () => string;
}

/** What the runner hands a custom matcher as `this`; only `isNot` is read. */
export interface MatcherContext {
  isNot?: boolean;
}

export const matchers = {
  toPass(this: MatcherContext | void, received: unknown): MatcherResult {
    // Report the opposite of what `.not` wants for anything that is not a passing or failing verdict, so
    // the assertion fails in either polarity.
    const negated = this !== undefined && this !== null && this.isNot === true;
    if (!isVerdict(received)) {
      return { pass: negated, message: () => `expected a Verdict ({ status, claim, evidence }), received ${describe(received)}` };
    }
    const detail = `${received.claim}\nevidence: ${JSON.stringify(received.evidence)}`;
    switch (received.status) {
      case 'PASS':
        return { pass: true, message: () => `expected the verdict not to pass, but it passed: ${detail}` };
      case 'FAIL':
        return { pass: false, message: () => `FAIL: ${detail}` };
      case 'BLOCKED':
        return { pass: negated, message: () => `BLOCKED: ${detail}` };
    }
  },
};

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
