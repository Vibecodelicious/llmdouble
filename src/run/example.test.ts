// The design's §5.0 test and §5.7 differential, run for real against the
// example client in examples/echo-client/ (a stand-in for a harness with a
// feature flag), in CI, with no network and no credentials. Stories that
// point the differential at a real harness copy this shape.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { matchers } from '../assert/matchers.js';
import { differential } from './differential.js';
import { run } from './run.js';

expect.extend(matchers);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCENARIO = join(ROOT, 'examples', 'echo-client', 'scenario.json');
const CLIENT = join(ROOT, 'examples', 'echo-client', 'client.mjs');
const KEY = 'sk-ant-echo-example';
const dir = mkdtempSync(join(tmpdir(), 'llmdouble-example-'));

describe('design 5.0: one run against the example client', () => {
  test('what the client sent, asserted from the recording', async () => {
    const rec = await run(SCENARIO, {
      exec: 'node examples/echo-client/client.mjs',
      env: { ANTHROPIC_BASE_URL: '$URL', ANTHROPIC_API_KEY: KEY, ECHO_FEATURE: '1' },
      cwd: ROOT,
      record: join(dir, 'on.jsonl'),
    });
    expect(rec.exitCode).toBe(0);
    expect(rec.count).toBe(2);
    expect(rec.summary).toEqual({ scripted: 2, served: 2, repeated: 0, asides: 0, unmatched: 0, ambiguous: 0, invalid: 0, complete: true });
    expect(rec.every.doesNotContain(KEY)).toPass();
    expect(rec.last.doesNotContain('[archive-me]')).toPass();
    expect(rec.last.tools.registered).toContain('read_file');

    const archived = rec.messagesMatching('[archive-me]');
    expect(rec.last.footprintOf(archived)).toBe(0);
    expect(rec.request(1).footprintOf(archived)).toBeGreaterThan(0);

    expect(readFileSync(join(dir, 'on.stdout.log'), 'utf8')).toBe('The parser has three passes: lex, parse, lower.\nDone.\n');
  });
});

describe('design 5.7: the differential', () => {
  const shared = {
    exec: 'node examples/echo-client/client.mjs',
    env: { ANTHROPIC_BASE_URL: '$URL', ANTHROPIC_API_KEY: KEY },
    cwd: ROOT,
  };

  test('the feature changes the second message of the second request and nothing else', async () => {
    const { on, off } = await differential(SCENARIO, {
      ...shared,
      on: { env: { ECHO_FEATURE: '1' } },
      off: { env: { ECHO_FEATURE: '0' } },
    });
    expect(on.count).toBe(2);
    expect(off.count).toBe(2);
    expect(on.diff(off).onlyIn({ messages: [2, 2] })).toPass();
    expect(off.last.contains('[archive-me]')).toPass();
    expect(on.last.doesNotContain('[archive-me]')).toPass();

    // One region per arm: a region belongs to the recording that created it.
    expect(on.last.footprintOf(on.messagesMatching('[archive-me]'))).toBe(0);
    expect(off.last.footprintOf(off.messagesMatching('[archive-me]'))).toBeGreaterThan(0);
  });

  test('negative control: a client that ignores the flag makes onlyIn FAIL with "recordings identical"', async () => {
    const source = readFileSync(CLIENT, 'utf8');
    const edited = source.replace("const featureOn = process.env.ECHO_FEATURE === '1';", 'const featureOn = false;');
    expect(edited).not.toBe(source);
    const broken = join(dir, 'client-ignores-flag.mjs');
    writeFileSync(broken, edited);

    const { on, off } = await differential(SCENARIO, {
      ...shared,
      exec: `node ${broken}`,
      on: { env: { ECHO_FEATURE: '1' } },
      off: { env: { ECHO_FEATURE: '0' } },
    });
    expect(on.count).toBe(2);
    expect(off.count).toBe(2);
    const verdict = on.diff(off).onlyIn({ messages: [2, 2] });
    expect(verdict).toEqual({ status: 'FAIL', claim: 'recordings identical', evidence: { count: 0 } });
    expect(verdict).not.toPass();
    expect(on.last.contains('[archive-me]')).toPass();
  });
});
