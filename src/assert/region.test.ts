import { describe, expect, test } from 'vitest';
import { recording, type MessageSpec } from './testing.js';
import { BlockedError } from './verdict.js';

const stepOne: MessageSpec = { role: 'user', content: 'step one: read the parser' };
const stepTwo: MessageSpec = { role: 'assistant', content: 'step two: nested capture groups are handled at line 412' };
const stepThree: MessageSpec = { role: 'user', content: 'step three: run the tests' };
const stepFour: MessageSpec = { role: 'assistant', content: 'step four: done' };
const later: MessageSpec = { role: 'user', content: 'now refactor' };
const prefix: MessageSpec = { role: 'user', content: 'an earlier turn' };
const placeholder: MessageSpec = { role: 'user', content: '[PRUNED: 4 messages archived]' };

/** The bytes `footprintOf` should report for the given wire messages of a request. */
function bytesOf(rec: ReturnType<typeof recording>, seq: number, indices: number[]): number {
  const messages = (JSON.parse(rec.request(seq).raw.body) as { messages: unknown[] }).messages;
  return indices.reduce((sum, i) => sum + Buffer.byteLength(JSON.stringify(messages[i]), 'utf8'), 0);
}

describe('messagesMatching', () => {
  const rec = recording([
    { messages: [stepOne, stepTwo, later] },
    { messages: [prefix, prefix, stepOne, stepTwo, later] },
    { messages: [placeholder, later] },
  ]);
  const region = rec.messagesMatching('line 412');

  test('selects every message containing the literal, re-evaluated per request', () => {
    expect(region.indicesIn(rec.request(1))).toEqual([1]);
    expect(region.indicesIn(rec.request(2))).toEqual([3]);
    expect(region.indicesIn(rec.request(3))).toEqual([]);
    expect(rec.messagesMatching('step').indicesIn(rec.request(2))).toEqual([2, 3]);
  });

  test('footprintOf follows content that moved position and measures 0 where it is absent', () => {
    expect(rec.request(1).footprintOf(region)).toBe(bytesOf(rec, 1, [1]));
    expect(rec.request(2).footprintOf(region)).toBe(bytesOf(rec, 2, [3]));
    expect(rec.request(2).footprintOf(region)).toBe(rec.request(1).footprintOf(region));
    expect(rec.last.footprintOf(region)).toBe(0);
    expect(region.isAnchored).toBe(true);
  });

  test('a region matching nothing in any request is unanchored and throws BlockedError', () => {
    const missing = rec.messagesMatching('never sent');
    expect(missing.isAnchored).toBe(false);
    expect(() => rec.last.footprintOf(missing)).toThrow(BlockedError);
    try {
      rec.request(1).footprintOf(missing);
    } catch (error) {
      expect((error as BlockedError).verdict).toEqual({
        status: 'BLOCKED',
        claim: 'region messagesMatching("never sent") matches nothing in any of the recording\'s 3 requests',
        evidence: { region: 'messagesMatching("never sent")', count: 3 },
      });
    }
  });

  test('the predicate reads every block: tool inputs and tool results are visible', () => {
    const tools = recording([
      {
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/parser.ts' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export function parse() {}' }] },
          { role: 'user', content: [{ type: 'image', source: { data: 'iVBOR' } }] },
        ],
      },
    ]);
    expect(tools.messagesMatching('src/parser.ts').indicesIn(tools.first)).toEqual([0]);
    expect(tools.messagesMatching('function parse').indicesIn(tools.first)).toEqual([1]);
    expect(tools.messagesMatching('iVBOR').indicesIn(tools.first)).toEqual([2]);
  });
});

describe('messagesBetween', () => {
  const rec = recording([
    { messages: [stepOne, stepTwo, stepThree, stepFour, later] },
    { messages: [prefix, stepOne, stepTwo, stepThree, stepFour, later] },
    { messages: [placeholder, later] },
  ]);
  const archived = rec.messagesBetween({ from: 'step one', to: 'step four' });

  test('selects the contiguous span from the first `from` through the first later `to`, per request', () => {
    expect(archived.indicesIn(rec.request(1))).toEqual([0, 1, 2, 3]);
    expect(archived.indicesIn(rec.request(2))).toEqual([1, 2, 3, 4]);
    expect(archived.indicesIn(rec.request(3))).toEqual([]);
  });

  test('footprintOf sums the wire bytes of the span and is 0 after the prune', () => {
    expect(rec.request(1).footprintOf(archived)).toBe(bytesOf(rec, 1, [0, 1, 2, 3]));
    expect(rec.request(2).footprintOf(archived)).toBe(bytesOf(rec, 2, [1, 2, 3, 4]));
    expect(rec.request(2).footprintOf(archived)).toBe(rec.request(1).footprintOf(archived));
    expect(rec.last.footprintOf(archived)).toBe(0);
    expect(rec.last.totalBytes).toBeLessThan(rec.request(1).totalBytes);
  });

  test('matches nothing in a request where either bound is missing, or `to` never follows `from`', () => {
    const partial = recording([
      { messages: [stepOne, stepTwo, later] },
      { messages: [stepThree, stepFour, later] },
      { messages: [stepFour, stepOne, later] },
      { messages: [{ role: 'user', content: 'step one and step four in one message' }, later] },
    ]);
    const region = partial.messagesBetween({ from: 'step one', to: 'step four' });
    expect(region.indicesIn(partial.request(1))).toEqual([]);
    expect(region.indicesIn(partial.request(2))).toEqual([]);
    expect(region.indicesIn(partial.request(3))).toEqual([]);
    expect(region.indicesIn(partial.request(4))).toEqual([]);
    expect(region.isAnchored).toBe(false);
    expect(() => partial.last.footprintOf(region)).toThrow(/matches nothing in any of the recording's 4 requests/);
  });

  test('takes the first `to` after `from`, not the last', () => {
    const rec2 = recording([{ messages: [stepOne, stepFour, stepTwo, stepFour, later] }]);
    expect(rec2.messagesBetween({ from: 'step one', to: 'step four' }).indicesIn(rec2.first)).toEqual([0, 1]);
  });

  test('anchoring is decided over the whole recording, so a region present only in request 1 still measures 0 later', () => {
    const rec3 = recording([{ messages: [stepOne, stepFour] }, { messages: [placeholder] }, { messages: [placeholder] }]);
    const region = rec3.messagesBetween({ from: 'step one', to: 'step four' });
    expect(rec3.last.footprintOf(region)).toBe(0);
    expect(rec3.request(1).footprintOf(region)).toBeGreaterThan(0);
  });
});
