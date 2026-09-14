import { describe, expect, test } from 'vitest';
import { Recording } from './recording.js';
import { recording, recordingFile } from './testing.js';
import { BlockedError } from './verdict.js';

const empty = recording([], { scripted: 2 });
const three = recording([
  { messages: [{ role: 'user', content: 'one, with SECRET' }] },
  { served: { kind: 'aside', index: 0, aside: 'title' }, messages: [{ role: 'user', content: 'title please' }] },
  { seq: 3, served: { kind: 'scripted', index: 1, aside: null }, messages: [{ role: 'user', content: 'three' }] },
]);

function blockedClaim(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof BlockedError) return error.verdict.claim;
    throw error;
  }
  throw new Error('expected a BlockedError');
}

describe('navigation', () => {
  test('count, first, last, and request(n) by seq', () => {
    expect(three.count).toBe(3);
    expect(three.first.seq).toBe(1);
    expect(three.last.seq).toBe(3);
    expect(three.request(1)).toBe(three.first);
    expect(three.request(3)).toBe(three.last);
    expect(three.request(2).served.kind).toBe('aside');
    expect(three.summary).toEqual({ scripted: 3, served: 2, repeated: 0, asides: 1, unmatched: 0, ambiguous: 0, invalid: 0, complete: true });
  });

  test('first and last throw BlockedError on an empty recording, naming the cause', () => {
    expect(empty.count).toBe(0);
    expect(empty.requests).toEqual([]);
    expect(blockedClaim(() => empty.first)).toBe('cannot read first: the recording has no requests');
    expect(blockedClaim(() => empty.last)).toBe('cannot read last: the recording has no requests');
    const named = new Recording(recordingFile([]), '/tmp/r.jsonl');
    expect(blockedClaim(() => named.last)).toBe('cannot read last: recording /tmp/r.jsonl has no requests');
  });

  test('an out-of-range request(n) throws BlockedError', () => {
    expect(blockedClaim(() => three.request(4))).toBe('request 4 is absent: the recording has 3 requests');
    expect(blockedClaim(() => three.request(0))).toBe('request 0 is absent: the recording has 3 requests');
    expect(blockedClaim(() => empty.request(1))).toBe('request 1 is absent: the recording has 0 requests');
    try {
      three.request(7);
    } catch (error) {
      expect((error as BlockedError).verdict.evidence).toEqual({ seq: 7, count: 3 });
    }
  });
});

describe('servedBy', () => {
  test('returns the single scripted request at that index; asides and repeats never match', () => {
    const rec = recording([
      { messages: [{ role: 'user', content: 'a' }] },
      { served: { kind: 'aside', index: 0, aside: 'title' } },
      { served: { kind: 'scripted', index: 1, aside: null } },
      { served: { kind: 'repeated', index: 1, aside: null } },
      { served: { kind: 'repeated', index: 1, aside: null } },
    ]);
    expect(rec.servedBy(0).seq).toBe(1);
    expect(rec.servedBy(1).seq).toBe(3);
    expect(rec.summary.repeated).toBe(2);
  });

  test('throws BlockedError when no request or more than one matches', () => {
    expect(blockedClaim(() => three.servedBy(2))).toBe('no request was served by scripted response 2 in the recording');
    expect(blockedClaim(() => empty.servedBy(0))).toBe('no request was served by scripted response 0 in the recording');
    const doubled = recording([{ served: { kind: 'scripted', index: 0, aside: null } }, { served: { kind: 'scripted', index: 0, aside: null } }]);
    expect(blockedClaim(() => doubled.servedBy(0))).toBe('2 requests (seqs 1, 2) were served by scripted response 0 in the recording');
  });
});

describe('every', () => {
  test('is BLOCKED on an empty recording for both claims', () => {
    expect(empty.every.doesNotContain('SECRET')).toEqual({
      status: 'BLOCKED',
      claim: 'cannot evaluate every request does not contain "SECRET": the recording has no requests',
      evidence: { count: 0 },
    });
    expect(empty.every.contains('x').status).toBe('BLOCKED');
  });

  test('doesNotContain passes only when every request passes and lists the failing seqs', () => {
    expect(three.every.doesNotContain('NOPE')).toEqual({ status: 'PASS', claim: 'every request does not contain "NOPE"', evidence: { count: 3 } });
    expect(three.every.doesNotContain('SECRET')).toEqual({
      status: 'FAIL',
      claim: 'every request does not contain "SECRET"',
      evidence: { count: 3, failingSeqs: [1] },
    });
    expect(three.every.contains('"model"').status).toBe('PASS');
    expect(three.every.contains('title')).toMatchObject({ status: 'FAIL', evidence: { count: 3, failingSeqs: [1, 3] } });
  });

  test('a request with normalized: null participates like any other', () => {
    const rec = recording([
      { messages: [{ role: 'user', content: 'clean' }] },
      { status: 413, served: { kind: 'invalid', index: null, aside: null }, body: '' },
      { status: 400, served: { kind: 'invalid', index: null, aside: null }, body: 'garbage SECRET garbage' },
    ]);
    expect(rec.every.doesNotContain('SECRET')).toMatchObject({ status: 'FAIL', evidence: { failingSeqs: [3] } });
    expect(rec.every.doesNotContain('OTHER').status).toBe('PASS');
    expect(rec.every.contains('SECRET')).toMatchObject({ status: 'FAIL', evidence: { failingSeqs: [1, 2] } });
  });

  test('an empty or absent search text is BLOCKED', () => {
    expect(three.every.doesNotContain('').status).toBe('BLOCKED');
    expect(three.every.doesNotContain(undefined as unknown as string).status).toBe('BLOCKED');
  });
});

describe('regions need a literal', () => {
  test('messagesMatching and messagesBetween throw BlockedError on an empty bound', () => {
    expect(blockedClaim(() => three.messagesMatching(''))).toBe('messagesMatching needs a non-empty literal, got ""');
    expect(blockedClaim(() => three.messagesBetween({ from: 'a', to: '' }))).toBe('messagesBetween.to needs a non-empty literal, got ""');
    expect(blockedClaim(() => three.messagesBetween({ from: undefined as unknown as string, to: 'b' }))).toContain('messagesBetween.from');
  });
});
