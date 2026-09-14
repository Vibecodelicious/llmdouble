// Deterministic, monotonic ids scoped to one server instance (epic C2).
//
// Each prefix has its own counter, so a run yields msg_1, msg_2, ... and
// toolu_1, toolu_2, ... regardless of how the surfaces interleave them.

export class IdCounters {
  private readonly counts = new Map<string, number>();

  /** The next id for `prefix`: `${prefix}${n}` with n starting at 1. */
  next(prefix: string): string {
    const n = (this.counts.get(prefix) ?? 0) + 1;
    this.counts.set(prefix, n);
    return `${prefix}${n}`;
  }
}
