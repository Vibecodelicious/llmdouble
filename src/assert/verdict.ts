// Verdicts (epic C4, design §5.2): PASS, FAIL, or BLOCKED, where BLOCKED
// means the apparatus could not evaluate the claim. An empty recording
// satisfies every absence claim, so an assertion whose inputs are absent
// reports BLOCKED, never PASS.
//
// Epic P6: methods that return a verdict carry BLOCKED as a status; methods
// that return a literal (`rec.last`, `footprintOf`) throw `BlockedError`
// instead, because a number has no "could not evaluate" value. Either way the
// test fails; neither way can it pass.

export type VerdictStatus = 'PASS' | 'FAIL' | 'BLOCKED';

/** A plain object so it serialises into evidence files. For BLOCKED, `claim` names the cause. */
export interface Verdict {
  status: VerdictStatus;
  claim: string;
  evidence: Record<string, unknown>;
}

/** Thrown by literal-returning methods that cannot evaluate; `verdict.claim` names the cause. */
export class BlockedError extends Error {
  override readonly name = 'BlockedError';
  readonly verdict: Verdict;

  constructor(claim: string, evidence: Record<string, unknown> = {}) {
    super(`BLOCKED: ${claim}`);
    this.verdict = { status: 'BLOCKED', claim, evidence };
  }
}

export function pass(claim: string, evidence: Record<string, unknown> = {}): Verdict {
  return { status: 'PASS', claim, evidence };
}

export function fail(claim: string, evidence: Record<string, unknown> = {}): Verdict {
  return { status: 'FAIL', claim, evidence };
}

export function blocked(claim: string, evidence: Record<string, unknown> = {}): Verdict {
  return { status: 'BLOCKED', claim, evidence };
}

/** True when `value` has the Verdict shape; the matcher uses it to reject non-verdicts. */
export function isVerdict(value: unknown): value is Verdict {
  if (typeof value !== 'object' || value === null) return false;
  const { status, claim, evidence } = value as Record<string, unknown>;
  return (
    (status === 'PASS' || status === 'FAIL' || status === 'BLOCKED') &&
    typeof claim === 'string' &&
    typeof evidence === 'object' &&
    evidence !== null
  );
}

/**
 * The search text of a content claim, or null when it is absent or empty. An empty literal is
 * contained by everything, and `process.env.SECRET` is `undefined` when unset; both would make an
 * absence claim vacuously true, so callers report BLOCKED instead.
 */
export function searchText(text: unknown): string | null {
  return typeof text === 'string' && text.length > 0 ? text : null;
}
