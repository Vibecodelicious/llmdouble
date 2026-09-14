import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openRecording, readRecording, redactHeaders, type RequestLine } from './recording.js';

const dir = mkdtempSync(join(tmpdir(), 'llmdouble-recording-'));

function requestLine(seq: number, kind: RequestLine['served']['kind'], index: number | null = null, aside: string | null = null): Omit<RequestLine, 'type'> {
  return {
    seq,
    at: '2026-09-13T00:00:00.000Z',
    method: 'POST',
    path: '/v1/messages',
    surface: 'anthropic',
    status: 200,
    served: { kind, index, aside },
    headers: { 'content-type': 'application/json' },
    body: '{"model":"m"}',
    normalized: null,
    responseBody: 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  };
}

describe('redactHeaders', () => {
  test('lowercases names and redacts the credential headers only', () => {
    expect(
      redactHeaders({
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        'x-api-key': 'sekret',
        Cookie: 'a=b',
        'Proxy-Authorization': 'p',
        'anthropic-version': '2023-06-01',
        'set-cookie': ['x=1', 'y=2'],
        absent: undefined,
      }),
    ).toEqual({
      'content-type': 'application/json',
      authorization: '[redacted]',
      'x-api-key': '[redacted]',
      cookie: '[redacted]',
      'proxy-authorization': '[redacted]',
      'anthropic-version': '2023-06-01',
      'set-cookie': 'x=1, y=2',
    });
  });
});

describe('RecordingWriter', () => {
  test('writes run, request, and summary lines in the C3 shapes and tallies counts', () => {
    const path = join(dir, 'full.jsonl');
    const writer = openRecording({ path, url: 'http://127.0.0.1:4321', scenario: '/tmp/s.json', scripted: 3 });
    writer.request(requestLine(1, 'scripted', 0));
    writer.request(requestLine(2, 'aside', 0, 'title'));
    writer.request(requestLine(3, 'scripted', 1));
    writer.request(requestLine(4, 'scripted', 2));
    writer.request(requestLine(5, 'repeated', 2));
    writer.request(requestLine(6, 'unmatched'));
    writer.request(requestLine(7, 'ambiguous'));
    writer.request(requestLine(8, 'invalid'));
    expect(writer.summary).toEqual({ scripted: 3, served: 4, repeated: 1, asides: 1, unmatched: 1, ambiguous: 1, invalid: 1 });
    const summary = writer.close();
    expect(summary).toEqual({ scripted: 3, served: 4, repeated: 1, asides: 1, unmatched: 1, ambiguous: 1, invalid: 1 });

    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines).toHaveLength(11);
    const run = JSON.parse(lines[0]!);
    expect(run).toEqual({ type: 'run', format: 1, startedAt: expect.any(String), url: 'http://127.0.0.1:4321', scenario: '/tmp/s.json' });
    expect(new Date(run.startedAt).toISOString()).toBe(run.startedAt);
    expect(JSON.parse(lines[2]!)).toEqual({ type: 'request', ...requestLine(2, 'aside', 0, 'title') });
    expect(Object.keys(JSON.parse(lines[1]!))).toEqual([
      'type', 'seq', 'at', 'method', 'path', 'surface', 'status', 'served', 'headers', 'body', 'normalized', 'responseBody',
    ]);
    expect(JSON.parse(lines[9]!)).toEqual({ type: 'summary', scripted: 3, served: 4, repeated: 1, asides: 1, unmatched: 1, ambiguous: 1, invalid: 1 });

    const parsed = readRecording(path);
    expect(parsed.run).toEqual(run);
    expect(parsed.requests.map((line) => line.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parsed.summary).toEqual({ type: 'summary', ...summary });
  });

  test('a second close is a no-op and a request after close throws', () => {
    const path = join(dir, 'closed.jsonl');
    const writer = openRecording({ path, url: 'http://127.0.0.1:1', scenario: null, scripted: 1 });
    writer.close();
    writer.close();
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect(() => writer.request(requestLine(1, 'scripted', 0))).toThrow('is closed');
  });

  test('an inline scenario records scenario: null and creates the directory', () => {
    const path = join(dir, 'nested', 'deeper', 'inline.jsonl');
    openRecording({ path, url: 'http://127.0.0.1:1', scenario: null, scripted: 1 }).close();
    expect(readRecording(path).run.scenario).toBeNull();
  });

  test('opening truncates a previous recording at the same path', () => {
    const path = join(dir, 'truncate.jsonl');
    writeFileSync(path, 'stale\n');
    openRecording({ path, url: 'http://127.0.0.1:1', scenario: null, scripted: 1 }).close();
    expect(readRecording(path).requests).toEqual([]);
  });
});

describe('readRecording', () => {
  test('tolerates a missing summary (unclean close)', () => {
    const path = join(dir, 'crash.jsonl');
    const writer = openRecording({ path, url: 'http://127.0.0.1:1', scenario: null, scripted: 1 });
    writer.request(requestLine(1, 'scripted', 0));
    const parsed = readRecording(path);
    expect(parsed.requests).toHaveLength(1);
    expect(parsed.summary).toBeNull();
  });

  test('rejects a file that does not start with a run line', () => {
    const path = join(dir, 'norun.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'summary' })}\n`);
    expect(() => readRecording(path)).toThrow('first line must be a run line');
  });

  test('rejects malformed lines and unknown types with the line number', () => {
    const path = join(dir, 'bad.jsonl');
    openRecording({ path, url: 'http://127.0.0.1:1', scenario: null, scripted: 1 });
    appendFileSync(path, '{not json\n');
    expect(() => readRecording(path)).toThrow(`${path}: line 2: not valid JSON`);
    writeFileSync(path, `${JSON.stringify({ type: 'run', format: 1 })}\n${JSON.stringify({ type: 'other' })}\n`);
    expect(() => readRecording(path)).toThrow(`${path}: line 2: unknown line type "other"`);
  });

  test('rejects an unsupported format', () => {
    const path = join(dir, 'format.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'run', format: 2 })}\n`);
    expect(() => readRecording(path)).toThrow('unsupported recording format 2');
  });
});
