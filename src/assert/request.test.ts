import { describe, expect, test } from 'vitest';
import { Request } from './request.js';
import { line, recording } from './testing.js';
import { BlockedError } from './verdict.js';

const req = new Request(
  line({
    seq: 4,
    system: 'You are a careful editor.',
    tools: ['read_file', 'write_file'],
    messages: [
      { role: 'user', content: 'Read the parser: café' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/parser.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export function parse() {}' }, 'thanks'] },
    ],
  }),
);

const unparsed = new Request(line({ seq: 9, status: 400, served: { kind: 'invalid', index: null, aside: null }, body: '{"model": ' }));

describe('Request fields', () => {
  test('exposes the line fields, the raw headers and body, and the normalised view', () => {
    expect(req.seq).toBe(4);
    expect(req.path).toBe('/v1/messages');
    expect(req.surface).toBe('anthropic');
    expect(req.status).toBe(200);
    expect(req.served).toEqual({ kind: 'scripted', index: 3, aside: null });
    expect(req.raw.headers).toEqual({ 'content-type': 'application/json' });
    expect(req.raw.body.startsWith('{"model":"claude-test"')).toBe(true);
    expect(req.normalized?.messages).toHaveLength(3);
    expect(unparsed.normalized).toBeNull();
  });

  test('totalBytes is the UTF-8 length of raw.body, not the character count', () => {
    expect(req.totalBytes).toBe(Buffer.byteLength(req.raw.body, 'utf8'));
    expect(req.totalBytes).toBe(req.raw.body.length + 1); // "é" is two bytes
    expect(unparsed.totalBytes).toBe(10);
  });
});

describe('contains / doesNotContain over raw.body', () => {
  test('a hit passes contains with the offset and fails doesNotContain with the same offset', () => {
    const offset = req.raw.body.indexOf('src/parser.ts');
    expect(req.contains('src/parser.ts')).toEqual({ status: 'PASS', claim: 'request 4 contains "src/parser.ts"', evidence: { seq: 4, offset } });
    expect(req.doesNotContain('src/parser.ts')).toEqual({
      status: 'FAIL',
      claim: 'request 4 does not contain "src/parser.ts"',
      evidence: { seq: 4, offset },
    });
  });

  test('a miss fails contains and passes doesNotContain, without an offset', () => {
    expect(req.contains('SECRET')).toEqual({ status: 'FAIL', claim: 'request 4 contains "SECRET"', evidence: { seq: 4 } });
    expect(req.doesNotContain('SECRET')).toEqual({ status: 'PASS', claim: 'request 4 does not contain "SECRET"', evidence: { seq: 4 } });
  });

  test('searches the wire bytes: raw field names and tool schemas are visible, normalised names are not', () => {
    expect(req.contains('"tool_use_id"').status).toBe('PASS');
    expect(req.contains('"input_schema"').status).toBe('PASS');
    expect(req.contains('toolUseId').status).toBe('FAIL');
  });

  test('an un-normalised request is searched like any other', () => {
    expect(unparsed.contains('"model"').status).toBe('PASS');
    expect(unparsed.doesNotContain('secret').status).toBe('PASS');
  });

  test('an empty or absent search text is BLOCKED, never a vacuous PASS', () => {
    expect(req.doesNotContain('')).toMatchObject({ status: 'BLOCKED', claim: expect.stringContaining('search text is empty or absent') });
    expect(req.contains(undefined as unknown as string).status).toBe('BLOCKED');
    expect(req.doesNotContain(undefined as unknown as string).status).toBe('BLOCKED');
  });
});

describe('system', () => {
  test('searches the normalised system text', () => {
    expect(req.system.contains('careful editor')).toEqual({ status: 'PASS', claim: 'request 4 system contains "careful editor"', evidence: { seq: 4, offset: 10 } });
    expect(req.system.doesNotContain('careful editor').status).toBe('FAIL');
    expect(req.system.contains('parser').status).toBe('FAIL'); // in a message, not the system text
    expect(req.system.doesNotContain('parser').status).toBe('PASS');
  });

  test('joins system blocks with newlines and is BLOCKED without a normalised view', () => {
    const two = new Request({ ...line({ seq: 1 }), normalized: { ...line({ seq: 1 }).normalized!, system: [{ text: 'a' }, { text: 'b' }] } });
    expect(two.system.contains('a\nb').status).toBe('PASS');
    expect(unparsed.system.contains('x')).toMatchObject({ status: 'BLOCKED', claim: expect.stringContaining('was not normalised (400 invalid)') });
    expect(unparsed.system.doesNotContain('x').status).toBe('BLOCKED');
    expect(req.system.contains('').status).toBe('BLOCKED');
  });
});

describe('messages and tools', () => {
  test('read the normalised view: count, roles as sent, texts with every block contributing', () => {
    expect(req.messages.count).toBe(3);
    expect(req.messages.roles).toEqual(['user', 'assistant', 'user']);
    expect(req.messages.texts).toEqual(['Read the parser: café', '{"path":"src/parser.ts"}', 'export function parse() {}thanks']);
    expect(req.tools.registered).toEqual(['read_file', 'write_file']);
  });

  test('throw BlockedError naming the cause on an un-normalised request', () => {
    expect(() => unparsed.messages).toThrow(BlockedError);
    expect(() => unparsed.tools).toThrow(BlockedError);
    try {
      unparsed.messages;
    } catch (error) {
      expect((error as BlockedError).verdict).toEqual({
        status: 'BLOCKED',
        claim: 'cannot read messages of request 9: the request was not normalised (400 invalid)',
        evidence: { seq: 9 },
      });
      expect((error as BlockedError).message).toBe('BLOCKED: cannot read messages of request 9: the request was not normalised (400 invalid)');
    }
  });
});

describe('footprintOf', () => {
  test('is BLOCKED on an un-normalised request even when the region is anchored', () => {
    const rec = recording([{ messages: [{ role: 'user', content: 'anchor here' }] }, { status: 400, served: { kind: 'invalid', index: null, aside: null }, body: 'anchor here' }]);
    const region = rec.messagesMatching('anchor');
    expect(rec.request(1).footprintOf(region)).toBeGreaterThan(0);
    expect(() => rec.request(2).footprintOf(region)).toThrow(/BLOCKED: cannot read footprintOf\(messagesMatching\("anchor"\)\) of request 2: the request was not normalised/);
  });
});
