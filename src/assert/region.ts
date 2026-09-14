// Regions (epic C4, design §5.4): a content predicate re-evaluated against
// each request, never a resolved set of message indices. Content that moved
// to a different position still matches; a request where the predicate
// matches nothing measures 0. A region that matches nothing in any request of
// its recording is unanchored, and measuring it throws `BlockedError`,
// because a row of satisfied zeroes is indistinguishable from removed content.

import { BlockedError } from './verdict.js';
import type { Recording } from './recording.js';
import type { Request } from './request.js';

/** Which message indices (0-based, into the normalised and raw arrays alike) the region selects in one request. */
export type RegionPredicate = (texts: string[]) => number[];

export class Region {
  private anchored: boolean | null = null;

  constructor(
    /** Human-readable, for claims: `messagesMatching("...")`. */
    readonly description: string,
    private readonly recording: Recording,
    private readonly predicate: RegionPredicate,
  ) {}

  /** The message indices this region selects in `request`; empty when it matches nothing there. */
  indicesIn(request: Request): number[] {
    return this.predicate(request.messageTexts());
  }

  /** True when the region matches at least one message in at least one request of its recording. Computed once. */
  get isAnchored(): boolean {
    if (this.anchored === null) this.anchored = this.recording.requests.some((request) => this.indicesIn(request).length > 0);
    return this.anchored;
  }

  /** Throw `BlockedError` unless the region is anchored somewhere in its recording. */
  requireAnchored(): void {
    if (!this.isAnchored) {
      throw new BlockedError(`region ${this.description} matches nothing in any of the recording's ${this.recording.count} requests`, {
        region: this.description,
        count: this.recording.count,
      });
    }
  }
}

/** Every message whose normalised text contains `text`. */
export function matchingPredicate(text: string): RegionPredicate {
  return (texts) => texts.flatMap((candidate, index) => (candidate.includes(text) ? [index] : []));
}

/**
 * The contiguous span from the first message containing `from` through the first later message
 * containing `to`; nothing when either bound is missing.
 */
export function betweenPredicate(from: string, to: string): RegionPredicate {
  return (texts) => {
    const start = texts.findIndex((text) => text.includes(from));
    if (start < 0) return [];
    const end = texts.findIndex((text, index) => index > start && text.includes(to));
    if (end < 0) return [];
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  };
}
