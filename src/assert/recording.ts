// A parsed recording (epic C4 `Recording`): navigation by seq and by served
// index, cross-request `every`, regions, and the differential.
//
// Every literal-returning accessor throws `BlockedError` when what it names
// is absent (`first` on an empty recording, `request(9)` of three, a
// `servedBy` index no request matches); every verdict-returning one reports
// BLOCKED on an empty recording. Neither can pass by accident.

import type { RecordingFile, RunLine, RunSummary } from '../core/recording.js';
import { Divergence } from './divergence.js';
import { betweenPredicate, matchingPredicate, Region } from './region.js';
import { Request } from './request.js';
import { blocked, BlockedError, fail, pass, searchText, type Verdict } from './verdict.js';

/** The run counts; `complete` is false when the file had no summary line (an unclean close). */
export interface RecordingSummary extends RunSummary {
  complete: boolean;
}

export class Recording {
  readonly run: RunLine;
  readonly requests: Request[];
  readonly summary: RecordingSummary;
  /** The file this was loaded from, or null for a recording built in memory. */
  readonly path: string | null;

  constructor(file: RecordingFile, path: string | null = null) {
    this.run = file.run;
    this.requests = file.requests.map((line) => new Request(line));
    this.summary = file.summary === null ? countFromRequests(this.requests) : { ...stripType(file.summary), complete: true };
    this.path = path;
  }

  get count(): number {
    return this.requests.length;
  }

  /** The first request; throws `BlockedError` on an empty recording. */
  get first(): Request {
    return this.requireAny('first')[0]!;
  }

  /** The last request; throws `BlockedError` on an empty recording. */
  get last(): Request {
    const requests = this.requireAny('last');
    return requests[requests.length - 1]!;
  }

  /** The request with `seq` n (1-based; the n-th line of any recording the server wrote). Throws `BlockedError` when absent. */
  request(n: number): Request {
    const found = this.requests.find((request) => request.seq === n);
    if (found === undefined) {
      throw new BlockedError(`request ${n} is absent: ${this.describe()} has ${this.count} request${this.count === 1 ? '' : 's'}`, {
        seq: n,
        count: this.count,
      });
    }
    return found;
  }

  /**
   * The one request served by scripted response `index` (`served.kind === 'scripted'`). Asides and repeats
   * never match. Throws `BlockedError` when no request or more than one matches.
   */
  servedBy(index: number): Request {
    const hits = this.requests.filter((request) => request.served.kind === 'scripted' && request.served.index === index);
    if (hits.length === 1) return hits[0]!;
    const seqs = hits.map((request) => request.seq);
    const cause = hits.length === 0 ? 'no request was' : `${hits.length} requests (seqs ${seqs.join(', ')}) were`;
    throw new BlockedError(`${cause} served by scripted response ${index} in ${this.describe()}`, { index, seqs });
  }

  /** Cross-request content claims over every request's `raw.body`; BLOCKED on an empty recording. */
  get every(): { contains(text: string): Verdict; doesNotContain(text: string): Verdict } {
    return {
      contains: (text) => this.everyClaim(text, true),
      doesNotContain: (text) => this.everyClaim(text, false),
    };
  }

  private everyClaim(text: string, expectPresent: boolean): Verdict {
    const claim = `every request ${expectPresent ? 'contains' : 'does not contain'} ${JSON.stringify(text)}`;
    if (searchText(text) === null) return blocked(`cannot evaluate ${claim}: the search text is empty or absent`, { count: 0 });
    if (this.count === 0) return blocked(`cannot evaluate ${claim}: ${this.describe()} has no requests`, { count: 0 });
    const verdicts = this.requests.map((request) => (expectPresent ? request.contains(text) : request.doesNotContain(text)));
    const failingSeqs = this.requests.filter((_, i) => verdicts[i]!.status === 'FAIL').map((request) => request.seq);
    return failingSeqs.length === 0 ? pass(claim, { count: this.count }) : fail(claim, { count: this.count, failingSeqs });
  }

  /** Every message whose normalised text contains `text`, re-evaluated per request. */
  messagesMatching(text: string): Region {
    return new Region(`messagesMatching(${JSON.stringify(text)})`, this, matchingPredicate(this.requireLiteral(text, 'messagesMatching')));
  }

  /** The span from the first message containing `from` through the first later message containing `to`, per request. */
  messagesBetween(bounds: { from: string; to: string }): Region {
    const from = this.requireLiteral(bounds.from, 'messagesBetween.from');
    const to = this.requireLiteral(bounds.to, 'messagesBetween.to');
    return new Region(`messagesBetween(${JSON.stringify(bounds)})`, this, betweenPredicate(from, to));
  }

  /** Differences between this recording's parsed raw bodies and `other`'s, paired by array position. */
  diff(other: Recording): Divergence {
    return new Divergence(this, other);
  }

  private requireLiteral(text: string, where: string): string {
    const literal = searchText(text);
    if (literal === null) throw new BlockedError(`${where} needs a non-empty literal, got ${JSON.stringify(text)}`, { text });
    return literal;
  }

  private requireAny(what: string): Request[] {
    if (this.count === 0) throw new BlockedError(`cannot read ${what}: ${this.describe()} has no requests`, { count: 0 });
    return this.requests;
  }

  private describe(): string {
    return this.path === null ? 'the recording' : `recording ${this.path}`;
  }
}

/**
 * Counts for a file with no summary line. Every per-kind count is exact; `scripted` (the scenario's
 * `responses.length`) is not recoverable from request lines, so it is the number of distinct scripted
 * responses that were served, a lower bound.
 */
function countFromRequests(requests: Request[]): RecordingSummary {
  const summary: RecordingSummary = { scripted: 0, served: 0, repeated: 0, asides: 0, unmatched: 0, ambiguous: 0, invalid: 0, complete: false };
  for (const { served } of requests) {
    switch (served.kind) {
      case 'scripted':
        summary.served += 1;
        summary.scripted += 1;
        break;
      case 'repeated':
        summary.served += 1;
        summary.repeated += 1;
        break;
      case 'aside':
        summary.asides += 1;
        break;
      case 'unmatched':
        summary.unmatched += 1;
        break;
      case 'ambiguous':
        summary.ambiguous += 1;
        break;
      case 'invalid':
        summary.invalid += 1;
        break;
    }
  }
  return summary;
}

function stripType(summary: RunSummary & { type?: 'summary' }): RunSummary {
  const { scripted, served, repeated, asides, unmatched, ambiguous, invalid } = summary;
  return { scripted, served, repeated, asides, unmatched, ambiguous, invalid };
}
