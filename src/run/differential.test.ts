import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readRecording } from '../core/recording.js';
import type { Scenario } from '../core/scenario.js';
import { armRun, differential } from './differential.js';

const dir = mkdtempSync(join(tmpdir(), 'llmdouble-differential-'));
let counter = 0;

const scenario: Scenario = { responses: [{ say: 'shared say' }] };

/** A `node -e` client that POSTs `text` (a JS expression) to `$BASE/v1/messages`. */
function client(text: string): string {
  const script =
    `fetch(process.env.BASE + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' },` +
    ` body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: ${text} }] }) })` +
    `.then((r) => r.text()).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })`;
  return `node -e ${JSON.stringify(script)}`;
}

function fresh(): string {
  const cwd = join(dir, `case-${++counter}`);
  mkdirSync(cwd);
  return cwd;
}

describe('armRun', () => {
  const shared = { exec: 'shared-exec', env: { A: '1', B: 'shared' }, setup: 'shared-setup', cwd: '/cwd', timeoutMs: 5 };

  test('per-arm env merges over shared env; exec, setup, and scenario override; cwd and timeoutMs are shared', () => {
    const [scn, opts] = armRun('on', scenario, {
      ...shared,
      on: { exec: 'on-exec', env: { B: 'on', C: '3' }, setup: 'on-setup', scenario: { responses: [{ say: 'on' }] } },
      off: {},
    });
    expect(scn).toEqual({ responses: [{ say: 'on' }] });
    expect(opts).toEqual({ exec: 'on-exec', env: { A: '1', B: 'on', C: '3' }, setup: 'on-setup', cwd: '/cwd', timeoutMs: 5 });
  });

  test('an arm with no overrides takes every shared value', () => {
    const [scn, opts] = armRun('off', scenario, { ...shared, on: {}, off: {} });
    expect(scn).toBe(scenario);
    expect(opts).toEqual({ exec: 'shared-exec', env: { A: '1', B: 'shared' }, setup: 'shared-setup', cwd: '/cwd', timeoutMs: 5 });
  });

  test('absent shared values stay absent rather than becoming undefined keys', () => {
    const [, opts] = armRun('on', scenario, { exec: 'x', on: {}, off: {} });
    expect(opts).toEqual({ exec: 'x', env: {} });
  });

  test('an arm without an exec anywhere is refused by name', () => {
    expect(() => armRun('off', scenario, { on: { exec: 'x' }, off: {} })).toThrow('differential: the off arm has no exec and none is shared');
  });
});

describe('differential', () => {
  test('runs both arms with merged env on separate servers and recordings', async () => {
    const cwd = fresh();
    const { on, off } = await differential(scenario, {
      exec: client("process.env.FEATURE + ' ' + process.env.SHARED"),
      env: { BASE: '$URL', SHARED: 'kept', FEATURE: 'unset' },
      cwd,
      on: { env: { FEATURE: 'on' } },
      off: { env: { FEATURE: 'off' } },
    });
    expect(on.exitCode).toBe(0);
    expect(off.exitCode).toBe(0);
    expect(on.last.contains('on kept')).toMatchObject({ status: 'PASS' });
    expect(off.last.contains('off kept')).toMatchObject({ status: 'PASS' });
    expect(on.path).not.toBe(off.path);
    expect(on.summary.complete).toBe(true);
    expect(off.summary.complete).toBe(true);
  });

  test('per-arm exec, setup, and scenario override the shared ones', async () => {
    const cwd = fresh();
    const { on, off } = await differential(scenario, {
      exec: client("'shared'"),
      env: { BASE: '$URL' },
      setup: 'echo shared-setup >> setup.txt',
      cwd,
      on: { setup: 'echo on-setup >> setup.txt' },
      off: { exec: 'exit 4', scenario: { responses: [{ say: 'off say' }] } },
    });
    expect(readFileSync(join(cwd, 'setup.txt'), 'utf8')).toBe('on-setup\nshared-setup\n');
    expect(on.count).toBe(1);
    expect(readRecording(on.path!).requests[0]!.responseBody).toContain('shared say');
    expect(off.exitCode).toBe(4);
    expect(off.count).toBe(0);
    expect(off.summary.scripted).toBe(1);
  });

  test('an arm without an exec rejects before either arm runs', async () => {
    await expect(differential(scenario, { on: { exec: 'true' }, off: {} })).rejects.toThrow('the off arm has no exec');
  });
});
