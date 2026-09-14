// The design's §5.0 test (DESIGN-test-specification-language.md), transcribed
// with the shipped names, against fixtures/prune.jsonl: three requests from
// a client that archived the "step one" .. "step four" span (which carries a
// secret) before its last request.
//
// The second test edits the fixture to put the archived text back into the
// last request and proves the same assertions then fail. It is the check
// that this file can fail at all.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { load } from './load.js';
import { matchers } from './matchers.js';
import type { Recording } from './recording.js';

expect.extend(matchers);

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/prune.jsonl');
const secret = 'SECRET-TOKEN-4f9c'; // the design reads process.env.API_SECRET; the fixture pins the value

/** Design §5.0, from `const rec = load(...)` down, with the verdict lines under `toPass()`. */
function design50(rec: Recording): void {
  expect(rec.count).toBe(3);
  expect(rec.last.doesNotContain(secret)).toPass();
  expect(rec.last.tools.registered).toContain('read_file');

  const archived = rec.messagesBetween({ from: 'step one', to: 'step four' });
  expect(rec.last.footprintOf(archived)).toBe(0);
  expect(rec.request(1).footprintOf(archived)).toBeGreaterThan(0);
}

describe('design §5.0', () => {
  test('the assertions hold against the recording the server produced', () => {
    const rec = load(FIXTURE);
    design50(rec);
    // The negative control the design's differential would supply: the secret was on the wire before the prune.
    expect(rec.request(1).contains(secret)).toPass();
    expect(rec.request(2).footprintOf(rec.messagesBetween({ from: 'step one', to: 'step four' }))).toBe(
      rec.request(1).footprintOf(rec.messagesBetween({ from: 'step one', to: 'step four' })),
    );
  });

  test('the same assertions fail when the fixture is edited to leave the archived text in the last request', () => {
    const edited = load(editedFixture());
    expect(() => design50(edited)).toThrow(/^FAIL: request 3 does not contain "SECRET-TOKEN-4f9c"/);
    const archived = edited.messagesBetween({ from: 'step one', to: 'step four' });
    expect(edited.last.footprintOf(archived)).toBe(edited.request(1).footprintOf(archived));
  });
});

/** The fixture with request 1's four archived messages restored in place of request 3's placeholder, in body and normalised view alike. */
function editedFixture(): string {
  const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter((line) => line.length > 0);
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const first = parsed.find((line) => line.type === 'request' && line.seq === 1)!;
  const last = parsed.find((line) => line.type === 'request' && line.seq === 3)!;
  const firstBody = JSON.parse(first.body as string) as { messages: unknown[] };
  const lastBody = JSON.parse(last.body as string) as { messages: unknown[] };
  lastBody.messages.splice(0, 1, ...firstBody.messages.slice(0, 4));
  last.body = JSON.stringify(lastBody);
  const firstNormalized = first.normalized as { messages: unknown[] };
  const lastNormalized = last.normalized as { messages: unknown[] };
  lastNormalized.messages.splice(0, 1, ...firstNormalized.messages.slice(0, 4));
  const path = join(mkdtempSync(join(tmpdir(), 'llmdouble-design-')), 'edited.jsonl');
  writeFileSync(path, `${parsed.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return path;
}
