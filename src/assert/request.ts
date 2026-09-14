// One recorded request (epic C4 `Request`): the raw body as evidence, the
// normalised view for structure, content verdicts, and scoped measurement.
//
// `contains` / `doesNotContain` search `raw.body`, so a request the surface
// could not normalise participates like any other. `system`, `messages`,
// `tools`, and `footprintOf` need the normalised view; on a request with
// `normalized: null` they report BLOCKED (verdicts) or throw `BlockedError`
// (literals) rather than answering from nothing.

import { messageText, systemText, type NormalizedRequest } from '../core/normalize.js';
import type { RequestLine, Served, SurfaceName } from '../core/recording.js';
import type { Region } from './region.js';
import { blocked, BlockedError, fail, pass, searchText, type Verdict } from './verdict.js';

export interface ContentClaims {
  contains(text: string): Verdict;
  doesNotContain(text: string): Verdict;
}

export class Request {
  readonly seq: number;
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly surface: SurfaceName | null;
  readonly status: number;
  readonly served: Served;
  readonly raw: { headers: Record<string, string>; body: string };
  readonly normalized: NormalizedRequest | null;
  readonly responseBody: string;
  private parsedBody: { value: unknown } | null = null;
  private texts: string[] | null = null;

  constructor(line: RequestLine) {
    this.seq = line.seq;
    this.at = line.at;
    this.method = line.method;
    this.path = line.path;
    this.surface = line.surface;
    this.status = line.status;
    this.served = line.served;
    this.raw = { headers: line.headers, body: line.body };
    this.normalized = line.normalized;
    this.responseBody = line.responseBody;
  }

  /** PASS when `text` occurs in `raw.body`; evidence carries the offset of the first hit. */
  contains(text: string): Verdict {
    return this.rawClaim(text, true);
  }

  /** PASS when `text` does not occur in `raw.body`; a hit fails with its offset. */
  doesNotContain(text: string): Verdict {
    return this.rawClaim(text, false);
  }

  private rawClaim(text: string, expectPresent: boolean): Verdict {
    const claim = `request ${this.seq} ${expectPresent ? 'contains' : 'does not contain'} ${JSON.stringify(text)}`;
    const needle = searchText(text);
    if (needle === null) return blocked(`cannot evaluate ${claim}: the search text is empty or absent`, { seq: this.seq });
    const offset = this.raw.body.indexOf(needle);
    const evidence = offset >= 0 ? { seq: this.seq, offset } : { seq: this.seq };
    return (offset >= 0) === expectPresent ? pass(claim, evidence) : fail(claim, evidence);
  }

  /** Content claims over the normalised system text (every system block, newline-joined). */
  get system(): ContentClaims {
    return {
      contains: (text) => this.systemClaim(text, true),
      doesNotContain: (text) => this.systemClaim(text, false),
    };
  }

  private systemClaim(text: string, expectPresent: boolean): Verdict {
    const claim = `request ${this.seq} system ${expectPresent ? 'contains' : 'does not contain'} ${JSON.stringify(text)}`;
    const needle = searchText(text);
    if (needle === null) return blocked(`cannot evaluate ${claim}: the search text is empty or absent`, { seq: this.seq });
    if (this.normalized === null) return blocked(`cannot evaluate ${claim}: ${this.unnormalised()}`, { seq: this.seq });
    const offset = systemText(this.normalized).indexOf(needle);
    const evidence = offset >= 0 ? { seq: this.seq, offset } : { seq: this.seq };
    return (offset >= 0) === expectPresent ? pass(claim, evidence) : fail(claim, evidence);
  }

  /** Message structure from the normalised view. Throws `BlockedError` on an un-normalised request. */
  get messages(): { count: number; roles: string[]; texts: string[] } {
    const normalized = this.requireNormalized('messages');
    return {
      count: normalized.messages.length,
      roles: normalized.messages.map((message) => message.role),
      texts: this.messageTexts(),
    };
  }

  /** Registered tool names, in wire order. Throws `BlockedError` on an un-normalised request. */
  get tools(): { registered: string[] } {
    return { registered: this.requireNormalized('tools').tools.map((tool) => tool.name) };
  }

  /** The UTF-8 length of `raw.body`. A literal with no verdict: whole-payload deltas are not a sound claim. */
  get totalBytes(): number {
    return Buffer.byteLength(this.raw.body, 'utf8');
  }

  /**
   * The UTF-8 byte sum of `JSON.stringify(rawMessages[i])` over the indices the region matches here,
   * where `rawMessages` is the parsed raw body's `messages` array. Throws `BlockedError` when the region is
   * unanchored (matches nothing in any request of its recording) or this request was not normalised. A
   * region anchored elsewhere but absent here measures 0: that is the signal, not an error.
   */
  footprintOf(region: Region): number {
    region.requireAnchored();
    this.requireNormalized(`footprintOf(${region.description})`);
    const rawMessages = this.rawMessages();
    let bytes = 0;
    for (const index of region.indicesIn(this)) {
      const message = rawMessages[index];
      if (message === undefined) {
        throw new BlockedError(`request ${this.seq} raw body has no messages[${index}] to measure`, { seq: this.seq, index });
      }
      bytes += Buffer.byteLength(JSON.stringify(message), 'utf8');
    }
    return bytes;
  }

  /** Each message's normalised text (C3): every block's contribution concatenated, so no block is invisible. */
  messageTexts(): string[] {
    if (this.texts === null) this.texts = this.normalized === null ? [] : this.normalized.messages.map(messageText);
    return this.texts;
  }

  private rawMessages(): unknown[] {
    if (this.parsedBody === null) {
      try {
        this.parsedBody = { value: JSON.parse(this.raw.body) };
      } catch {
        throw new BlockedError(`request ${this.seq} raw body is not JSON`, { seq: this.seq });
      }
    }
    const messages = (this.parsedBody.value as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(messages)) throw new BlockedError(`request ${this.seq} raw body has no messages array`, { seq: this.seq });
    return messages;
  }

  private requireNormalized(what: string): NormalizedRequest {
    if (this.normalized === null) throw new BlockedError(`cannot read ${what} of request ${this.seq}: ${this.unnormalised()}`, { seq: this.seq });
    return this.normalized;
  }

  private unnormalised(): string {
    return `the request was not normalised (${this.status} ${this.served.kind})`;
  }
}
