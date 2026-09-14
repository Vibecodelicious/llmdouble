import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { load } from '../assert/load.js';
import type { Scenario } from '../core/scenario.js';
import { DEFAULT_TIMEOUT_MS, logPaths, run, substituteEnv, substituteUrl } from './run.js';

const dir = mkdtempSync(join(tmpdir(), 'llmdouble-run-'));
let counter = 0;

const scenario: Scenario = { responses: [{ say: 'first' }, { say: 'second' }] };

/** A `node -e` client that POSTs one Messages request to the url in `expr` (a JS expression) and exits 0. */
function client(expr: string, text = 'hello'): string {
  const script =
    `fetch((${expr}) + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' },` +
    ` body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: ${JSON.stringify(text)} }] }) })` +
    `.then((r) => r.text()).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })`;
  return `node -e ${JSON.stringify(script)}`;
}

function fresh(): { cwd: string; record: string } {
  const cwd = join(dir, `case-${++counter}`);
  mkdirSync(cwd);
  return { cwd, record: join(cwd, 'run.jsonl') };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function untilDead(pid: number, withinMs = 3000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return !alive(pid);
}

describe('substitution', () => {
  test('replaces every $URL token and leaves longer names alone', () => {
    expect(substituteUrl('curl $URL/v1/messages -H x; echo $URL', 'http://127.0.0.1:1')).toBe(
      'curl http://127.0.0.1:1/v1/messages -H x; echo http://127.0.0.1:1',
    );
    expect(substituteUrl('$URLS $URL_X $url', 'u')).toBe('$URLS $URL_X $url');
    expect(substituteUrl('no placeholder', 'u')).toBe('no placeholder');
  });

  test('substitutes in every env value', () => {
    expect(substituteEnv({ BASE: '$URL', KEY: 'x', BOTH: '$URL and $URL' }, 'u')).toEqual({ BASE: 'u', KEY: 'x', BOTH: 'u and u' });
  });

  test('logs sit next to the recording', () => {
    expect(logPaths('/tmp/r/run.jsonl')).toEqual({ stdout: '/tmp/r/run.stdout.log', stderr: '/tmp/r/run.stderr.log' });
    expect(logPaths('/tmp/r/run')).toEqual({ stdout: '/tmp/r/run.stdout.log', stderr: '/tmp/r/run.stderr.log' });
  });

  test('the default timeout is two minutes', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(120000);
  });
});

describe('run with a string exec', () => {
  test('substitutes $URL in exec, runs under sh -c, and returns the recording with exitCode 0', async () => {
    const { cwd, record } = fresh();
    const rec = await run(scenario, { exec: `${client('process.argv[1]')} $URL`, cwd, record });
    expect(rec.exitCode).toBe(0);
    expect(rec.path).toBe(record);
    expect(rec.count).toBe(1);
    expect(rec.last.served).toEqual({ kind: 'scripted', index: 0, aside: null });
    expect(rec.last.contains('hello')).toMatchObject({ status: 'PASS' });
    expect(rec.summary).toMatchObject({ complete: true, scripted: 2, served: 1 });
    expect(rec.run.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('substitutes $URL in every env value and merges over the current environment', async () => {
    const { cwd, record } = fresh();
    const rec = await run(scenario, { exec: client('process.env.BASE', 'via env'), env: { BASE: '$URL' }, cwd, record });
    expect(rec.exitCode).toBe(0);
    expect(rec.last.contains('via env')).toMatchObject({ status: 'PASS' });
  });

  test('runs setup before exec, both in cwd with $URL, and captures their output next to the recording', async () => {
    const { cwd, record } = fresh();
    const rec = await run(scenario, {
      setup: 'echo "setup $URL" >> order.txt; echo setup-out; echo setup-err >&2',
      exec: 'echo exec >> order.txt; echo exec-out; echo exec-err >&2',
      cwd,
      record,
    });
    expect(rec.exitCode).toBe(0);
    expect(rec.count).toBe(0);
    expect(readFileSync(join(cwd, 'order.txt'), 'utf8')).toBe(`setup ${rec.run.url}\nexec\n`);
    expect(readFileSync(join(cwd, 'run.stdout.log'), 'utf8')).toBe('setup-out\nexec-out\n');
    expect(readFileSync(join(cwd, 'run.stderr.log'), 'utf8')).toBe('setup-err\nexec-err\n');
  });

  test('a second run at the same record path starts the logs fresh, like the recording', async () => {
    const { cwd, record } = fresh();
    await run(scenario, { setup: 'echo setup-one', exec: 'echo run-one; echo err-one >&2', cwd, record });
    const rec = await run(scenario, { setup: 'echo setup-two', exec: 'echo run-two; echo err-two >&2', cwd, record });
    expect(rec.exitCode).toBe(0);
    expect(readFileSync(join(cwd, 'run.stdout.log'), 'utf8')).toBe('setup-two\nrun-two\n');
    expect(readFileSync(join(cwd, 'run.stderr.log'), 'utf8')).toBe('err-two\n');
  });

  test('a non-zero exit is returned, not thrown', async () => {
    const { cwd, record } = fresh();
    const rec = await run(scenario, { exec: 'exit 3', cwd, record });
    expect(rec.exitCode).toBe(3);
    expect(rec.summary.complete).toBe(true);
  });

  test('a failing setup throws before exec runs', async () => {
    const { cwd, record } = fresh();
    await expect(run(scenario, { setup: 'exit 5', exec: 'touch ran', cwd, record })).rejects.toThrow('setup exited with 5');
    expect(existsSync(join(cwd, 'ran'))).toBe(false);
    expect(load(record).summary.complete).toBe(true);
  });

  test('a timeout kills the process group, closes the server, and throws with the recording path', async () => {
    const { cwd, record } = fresh();
    const started = Date.now();
    await expect(run(scenario, { exec: 'sleep 30 & echo $! > child.pid; wait', cwd, record, timeoutMs: 300 })).rejects.toThrow(
      `run timed out after 300 ms; the process group was killed (recording: ${record})`,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    const grandchild = Number(readFileSync(join(cwd, 'child.pid'), 'utf8').trim());
    expect(await untilDead(grandchild)).toBe(true);
    expect(load(record).summary.complete).toBe(true);
  });

  test('whatever exec left running in its group is killed when exec exits', async () => {
    const { cwd, record } = fresh();
    const rec = await run(scenario, { exec: 'sleep 30 & echo $! > child.pid', cwd, record });
    expect(rec.exitCode).toBe(0);
    const straggler = Number(readFileSync(join(cwd, 'child.pid'), 'utf8').trim());
    expect(await untilDead(straggler)).toBe(true);
  });

  test('a server that cannot start throws before anything is executed', async () => {
    const { cwd } = fresh();
    const notADir = join(cwd, 'file');
    writeFileSync(notADir, '');
    await expect(run(scenario, { exec: 'touch ran', cwd, record: join(notADir, 'run.jsonl') })).rejects.toThrow(/ENOTDIR|EEXIST/);
    expect(existsSync(join(cwd, 'ran'))).toBe(false);
  });

  test('a server failure mid-run aborts the run promptly, kills the command, and throws with the recording path', async () => {
    const { cwd } = fresh();
    const recordDir = join(cwd, 'rec');
    const record = join(recordDir, 'run.jsonl');
    const started = Date.now();
    await expect(
      run(scenario, {
        exec: `rm -rf ${recordDir}; ${client('process.argv[1]')} $URL; sleep 30 & echo $! > child.pid; wait`,
        cwd,
        record,
        timeoutMs: 20000,
      }),
    ).rejects.toThrow(/llmdouble server failed during the run: .*ENOENT.*\(recording: .*run\.jsonl\)/);
    expect(Date.now() - started).toBeLessThan(5000);
    if (existsSync(join(cwd, 'child.pid'))) {
      expect(await untilDead(Number(readFileSync(join(cwd, 'child.pid'), 'utf8').trim()))).toBe(true);
    }
  });
});

describe('run with a function exec', () => {
  test('is called with { url }, awaited, and reports exitCode null', async () => {
    const { record } = fresh();
    const seen: string[] = [];
    const rec = await run(scenario, {
      record,
      exec: async ({ url }) => {
        seen.push(url);
        for (const text of ['one', 'two']) {
          const res = await fetch(`${url}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: text }] }),
          });
          await res.text();
        }
      },
    });
    expect(seen).toEqual([rec.run.url]);
    expect(rec.exitCode).toBeNull();
    expect(rec.count).toBe(2);
    expect(rec.summary).toMatchObject({ complete: true, served: 2 });
  });

  test('a throwing function is rethrown after the server is closed', async () => {
    const { record } = fresh();
    await expect(
      run(scenario, {
        record,
        exec: async () => {
          throw new Error('driver broke');
        },
      }),
    ).rejects.toThrow('driver broke');
    expect(load(record).summary.complete).toBe(true);
  });

  test('a function that outlives the timeout makes run throw with the recording path', async () => {
    const { record } = fresh();
    let pending: NodeJS.Timeout | undefined;
    await expect(
      run(scenario, {
        record,
        timeoutMs: 200,
        exec: () =>
          new Promise<void>((resolve) => {
            pending = setTimeout(resolve, 30000);
          }),
      }),
    ).rejects.toThrow(`run timed out after 200 ms; the process group was killed (recording: ${record})`);
    clearTimeout(pending);
  });
});
