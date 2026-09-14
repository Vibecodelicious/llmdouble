import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { load } from './load.js';
import { jsonl, recordingFile } from './testing.js';

const dir = mkdtempSync(join(tmpdir(), 'llmdouble-load-'));

function write(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe('load', () => {
  test('parses a complete file: run line, requests in order, summary with complete = true', () => {
    const file = recordingFile([{}, { served: { kind: 'aside', index: 0, aside: 'title' } }, {}], { scripted: 3 });
    const rec = load(write('complete.jsonl', jsonl(file)));
    expect(rec.run).toEqual(file.run);
    expect(rec.count).toBe(3);
    expect(rec.requests.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rec.request(2).served).toEqual({ kind: 'aside', index: 0, aside: 'title' });
    expect(rec.summary).toEqual({ scripted: 3, served: 2, repeated: 0, asides: 1, unmatched: 0, ambiguous: 0, invalid: 0, complete: true });
    expect(rec.path).toMatch(/complete\.jsonl$/);
  });

  test('a file without a summary line loads with counts computed from the request lines and complete = false', () => {
    const file = recordingFile(
      [
        {},
        { served: { kind: 'aside', index: 0, aside: 'title' } },
        { seq: 3, served: { kind: 'scripted', index: 1, aside: null } },
        { served: { kind: 'repeated', index: 1, aside: null } },
        { served: { kind: 'unmatched', index: null, aside: null }, status: 404, body: 'nope' },
        { served: { kind: 'invalid', index: null, aside: null }, status: 400, body: '{' },
        { served: { kind: 'ambiguous', index: null, aside: null }, status: 500 },
      ],
      { summary: false },
    );
    const rec = load(write('crashed.jsonl', jsonl(file)));
    expect(rec.count).toBe(7);
    expect(rec.summary).toEqual({ scripted: 2, served: 3, repeated: 1, asides: 1, unmatched: 1, ambiguous: 1, invalid: 1, complete: false });
  });

  test('an empty recording (run line only) loads with count 0', () => {
    const rec = load(write('empty.jsonl', jsonl(recordingFile([], { scripted: 1 }))));
    expect(rec.count).toBe(0);
    expect(rec.summary.complete).toBe(true);
    const crashed = load(write('empty-crashed.jsonl', jsonl(recordingFile([], { summary: false }))));
    expect(crashed.count).toBe(0);
    expect(crashed.summary.complete).toBe(false);
  });

  test('rejects a file whose first line is not a run line with format 1', () => {
    const file = recordingFile([{}]);
    const request = JSON.stringify(file.requests[0]);
    expect(() => load(write('no-run.jsonl', `${request}\n`))).toThrow(/first line must be a run line/);
    const run2 = JSON.stringify({ ...file.run, format: 2 });
    expect(() => load(write('format-2.jsonl', `${run2}\n${request}\n`))).toThrow(/unsupported recording format 2/);
    expect(() => load(write('blank.jsonl', ''))).toThrow(/first line must be a run line/);
    expect(() => load(write('not-json.jsonl', 'hello\n'))).toThrow(/line 1: not valid JSON/);
    expect(() => load(write('unknown-type.jsonl', `${JSON.stringify(file.run)}\n{"type":"nope"}\n`))).toThrow(/line 2: unknown line type "nope"/);
    expect(() => load(join(dir, 'missing.jsonl'))).toThrow(/ENOENT/);
  });
});
