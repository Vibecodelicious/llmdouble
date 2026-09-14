import { describe, expect, test } from 'vitest';
import { diffBodies, diffValues, isUnder } from './divergence.js';
import { recording, type LineSpec } from './testing.js';
import { BlockedError } from './verdict.js';

const base: LineSpec[] = [
  { messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }] },
  { messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }, { role: 'assistant', content: 'four' }] },
];

describe('diffValues', () => {
  test('reports the path of every differing leaf, added or removed key, and extra array element', () => {
    expect(diffValues({ a: 1, b: { c: [1, 2, 3] } }, { a: 1, b: { c: [1, 9, 3, 4] } })).toEqual(['$.b.c[1]', '$.b.c[3]']);
    expect(diffValues({ a: 1 }, { a: 1, extra: true })).toEqual(['$.extra']);
    expect(diffValues({ a: 1, gone: null }, { a: 1 })).toEqual(['$.gone']);
    expect(diffValues({ a: { deep: 1 } }, { a: 'flat' })).toEqual(['$.a']);
    expect(diffValues([1], { 0: 1 })).toEqual(['$']);
    expect(diffValues(1, '1')).toEqual(['$']);
    expect(diffValues(null, undefined)).toEqual(['$']);
    expect(diffValues({ a: [] }, { a: [] })).toEqual([]);
  });

  test('quotes keys that are not identifiers', () => {
    expect(diffValues({ 'x-api-key': 'a' }, { 'x-api-key': 'b' })).toEqual(['$["x-api-key"]']);
    expect(diffValues({ $ok_1: 'a' }, { $ok_1: 'b' })).toEqual(['$.$ok_1']);
  });

  test('diffBodies compares non-JSON bodies as whole strings', () => {
    expect(diffBodies('{"a":1}', '{"a":2}')).toEqual(['$.a']);
    expect(diffBodies('not json', 'not json')).toEqual([]);
    expect(diffBodies('not json', '{"a":1}')).toEqual(['$']);
    expect(diffBodies('', '')).toEqual([]);
  });

  test('isUnder respects path boundaries', () => {
    expect(isUnder('$.messages[1].content[0].text', '$.messages[1]')).toBe(true);
    expect(isUnder('$.messages[1]', '$.messages[1]')).toBe(true);
    expect(isUnder('$.messages[10]', '$.messages[1]')).toBe(false);
    expect(isUnder('$.messagesX', '$.messages')).toBe(false);
    expect(isUnder('$.messages[1]', '$.messages')).toBe(true);
    expect(isUnder('$', '$.messages')).toBe(false);
  });
});

describe('Recording.diff', () => {
  test('identical recordings yield isEmpty with an entry of no paths per pair', () => {
    const d = recording(base).diff(recording(base));
    expect(d.isEmpty).toBe(true);
    expect(d.requests).toEqual([
      { seq: 1, paths: [] },
      { seq: 2, paths: [] },
    ]);
  });

  test('yields per-seq JSON paths of differing leaves in the parsed raw bodies', () => {
    const edited: LineSpec[] = [
      base[0]!,
      { messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'TWO' }, { role: 'user', content: 'three' }], tools: ['read_file'] },
    ];
    const d = recording(base).diff(recording(edited));
    expect(d.isEmpty).toBe(false);
    expect(d.requests).toEqual([
      { seq: 1, paths: [] },
      { seq: 2, paths: ['$.messages[1].content', '$.messages[3]', '$.tools'] },
    ]);
  });

  test('pairs by array position and reports ["$"] for every unpaired tail index', () => {
    const longer = recording([...base, { seq: 3, messages: [{ role: 'user', content: 'extra' }] }, { seq: 4 }]);
    const d = recording(base).diff(longer);
    expect(d.requests).toEqual([
      { seq: 1, paths: [] },
      { seq: 2, paths: [] },
      { seq: 3, paths: ['$'] },
      { seq: 4, paths: ['$'] },
    ]);
    expect(d.isEmpty).toBe(false);
    expect(longer.diff(recording(base)).requests.slice(2)).toEqual([
      { seq: 3, paths: ['$'] },
      { seq: 4, paths: ['$'] },
    ]);
    expect(recording([]).diff(recording([])).isEmpty).toBe(true);
  });

  test('diffs the raw bodies, so a change invisible to the normalised view still counts', () => {
    const a = recording([{ body: '{"model":"m","messages":[],"metadata":{"user_id":"a"}}', status: 200 }]);
    const b = recording([{ body: '{"model":"m","messages":[],"metadata":{"user_id":"b"}}', status: 200 }]);
    expect(a.diff(b).requests).toEqual([{ seq: 1, paths: ['$.metadata.user_id'] }]);
  });
});

describe('onlyIn', () => {
  const on = recording([
    { messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }, { role: 'assistant', content: 'four' }] },
  ]);
  const off = recording([
    { messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'TWO' }, { role: 'user', content: 'THREE' }, { role: 'assistant', content: 'four' }] },
  ]);

  test('identical recordings FAIL with claim "recordings identical"', () => {
    expect(on.diff(on).onlyIn({ messages: [1, 4] })).toEqual({ status: 'FAIL', claim: 'recordings identical', evidence: { count: 0 } });
    expect(on.diff(on).onlyIn({ paths: ['$'] }).claim).toBe('recordings identical');
  });

  test('messages selector: PASS when every difference is inside the 1-based inclusive range', () => {
    const verdict = on.diff(off).onlyIn({ messages: [2, 3] });
    expect(verdict).toEqual({
      status: 'PASS',
      claim: 'recordings differ only in messages 2..3',
      evidence: {
        count: 2,
        inside: [
          { seq: 1, path: '$.messages[1].content' },
          { seq: 1, path: '$.messages[2].content' },
        ],
      },
    });
    expect(on.diff(off).onlyIn({ messages: [1, 4] }).status).toBe('PASS');
  });

  test('messages selector: FAIL listing differences outside the range, from === to allowed', () => {
    expect(on.diff(off).onlyIn({ messages: [2, 2] })).toEqual({
      status: 'FAIL',
      claim: 'recordings differ only in messages 2..2',
      evidence: { count: 2, outside: [{ seq: 1, path: '$.messages[2].content' }] },
    });
    expect(on.diff(off).onlyIn({ messages: [3, 3] }).evidence.outside).toEqual([{ seq: 1, path: '$.messages[1].content' }]);
  });

  test('paths selector: prefixes accept nested paths, and a boundary is a boundary', () => {
    expect(on.diff(off).onlyIn({ paths: ['$.messages'] }).status).toBe('PASS');
    expect(on.diff(off).onlyIn({ paths: ['$.messages[1]', '$.messages[2].content'] }).status).toBe('PASS');
    expect(on.diff(off).onlyIn({ paths: ['$.messages[1]'] })).toMatchObject({ status: 'FAIL', evidence: { outside: [{ seq: 1, path: '$.messages[2].content' }] } });
    expect(on.diff(off).onlyIn({ paths: ['$.mess'] }).status).toBe('FAIL');
  });

  test('an unpaired request is a difference at "$", outside every selector', () => {
    const longer = recording([...base]);
    const d = recording([base[0]!]).diff(longer);
    expect(d.onlyIn({ messages: [1, 9] })).toMatchObject({ status: 'FAIL', evidence: { outside: [{ seq: 2, path: '$' }] } });
    expect(d.onlyIn({ paths: ['$'] }).status).toBe('PASS');
  });

  test('a malformed selector throws BlockedError', () => {
    expect(() => on.diff(off).onlyIn({ messages: [0, 1] })).toThrow(BlockedError);
    expect(() => on.diff(off).onlyIn({ messages: [3, 2] })).toThrow(BlockedError);
    expect(() => on.diff(off).onlyIn({ messages: [1.5, 2] })).toThrow(BlockedError);
    expect(() => on.diff(off).onlyIn({ paths: [] })).toThrow(BlockedError);
    expect(() => on.diff(off).onlyIn({ paths: [''] })).toThrow(BlockedError);
  });
});
