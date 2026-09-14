import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { defaultRecordPath, formatRequestBlock, formatSummary, main, parseServeArgs, runDiff, startServe, type CliIo } from './cli.js';
import { readRecording, type RequestLine } from './core/recording.js';

const dir = mkdtempSync(join(tmpdir(), 'llmdouble-cli-'));
const scenarioPath = join(dir, 'scenario.json');
writeFileSync(
  scenarioPath,
  JSON.stringify({
    responses: [{ say: 'first' }, { say: 'second' }],
    aside: [{ name: 'title', when: { system: { contains: 'title' } }, say: 'Untitled' }],
  }),
);

function io(): CliIo & { out: string; err: string } {
  const captured = {
    out: '',
    err: '',
    stdout(text: string) {
      captured.out += text;
    },
    stderr(text: string) {
      captured.err += text;
    },
  };
  return captured;
}

async function post(url: string, body: string, path = '/v1/messages'): Promise<number> {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  await res.text();
  return res.status;
}

const line: RequestLine = {
  type: 'request',
  seq: 2,
  at: '2026-09-13T14:22:09.000Z',
  method: 'POST',
  path: '/v1/messages',
  surface: 'anthropic',
  status: 200,
  served: { kind: 'scripted', index: 1, aside: null },
  headers: {},
  body: '{"model":"m","messages":[]}',
  normalized: { model: 'm', stream: true, maxTokens: null, system: [], messages: [{ role: 'user', content: [] }, { role: 'assistant', content: [] }, { role: 'user', content: [] }], tools: [{ name: 'a' }, { name: 'b' }] },
  responseBody: '',
};

describe('parseServeArgs', () => {
  test('parses every flag', () => {
    expect(parseServeArgs(['--scenario', 's.json', '--port', '8080', '--record', 'r.jsonl', '--raw'])).toEqual({
      kind: 'run',
      options: { scenario: 's.json', port: 8080, record: 'r.jsonl', raw: true },
    });
  });

  test('defaults port to 0, raw to false, and record to a timestamped file in the cwd', () => {
    const args = parseServeArgs(['--scenario', 's.json']);
    expect(args.kind).toBe('run');
    if (args.kind !== 'run') return;
    expect(args.options.port).toBe(0);
    expect(args.options.raw).toBe(false);
    expect(args.options.record).toMatch(/^\.\/llmdouble-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.jsonl$/);
    expect(defaultRecordPath(new Date('2026-09-13T14:22:09.123Z'))).toBe('./llmdouble-2026-09-13T14-22-09-123Z.jsonl');
  });

  test('reports help, a missing scenario, a bad port, and an unknown flag', () => {
    expect(parseServeArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseServeArgs(['-h', '--scenario', 'x'])).toEqual({ kind: 'help' });
    expect(parseServeArgs([])).toEqual({ kind: 'error', message: '--scenario is required' });
    expect(parseServeArgs(['--scenario', 's', '--port', 'abc'])).toMatchObject({ kind: 'error', message: expect.stringContaining('--port must be an integer') });
    expect(parseServeArgs(['--scenario', 's', '--port', '70000'])).toMatchObject({ kind: 'error' });
    expect(parseServeArgs(['--scenario', 's', '--filter', 'x'])).toMatchObject({ kind: 'error', message: expect.stringContaining('--filter') });
    expect(parseServeArgs(['--scenario', 's', 'extra'])).toMatchObject({ kind: 'error' });
  });
});

describe('formatRequestBlock', () => {
  test('prints seq, path, status, served kind, counts, bytes, and the delta', () => {
    const block = formatRequestBlock(line, 20);
    expect(block).toMatch(/^─+\nreq 2 {2}POST \/v1\/messages {2}200 {2}scripted\[1\] {2}\d{2}:\d{2}:\d{2}\n {2}messages 3 {3}tools 2 {3}total 27 B {3}\(\+7\)\n$/);
    expect(formatRequestBlock(line, null)).toContain('total 27 B\n');
    expect(formatRequestBlock(line, 1027)).toContain('(-1,000)');
  });

  test('names an aside, shows a bare kind for rejections, and dashes when nothing was normalised', () => {
    expect(formatRequestBlock({ ...line, served: { kind: 'aside', index: 0, aside: 'title' } }, null)).toContain('  aside[0] title  ');
    const rejected = formatRequestBlock({ ...line, status: 404, path: '/nope', served: { kind: 'unmatched', index: null, aside: null }, normalized: null }, null);
    expect(rejected).toContain('POST /nope  404  unmatched  ');
    expect(rejected).toContain('messages -   tools -');
  });

  test('--raw appends the body', () => {
    expect(formatRequestBlock(line, null, true)).toContain('\n  body {"model":"m","messages":[]}\n');
    expect(formatRequestBlock(line, null, false)).not.toContain('body ');
  });

  test('formatSummary reads like the design', () => {
    expect(formatSummary({ scripted: 3, served: 4, repeated: 1, asides: 1, unmatched: 0, ambiguous: 0, invalid: 0 })).toBe(
      '3 scripted, 4 served, 1 repeated, 1 asides, 0 unmatched, 0 ambiguous, 0 invalid',
    );
  });
});

describe('serve', () => {
  test('prints the listening line, one block per request, and the summary on stop', async () => {
    const out = io();
    const record = join(dir, 'serve.jsonl');
    const handle = await startServe({ scenario: scenarioPath, port: 0, record, raw: false }, out);
    expect(out.out).toBe(`listening on ${handle.url}\nrecording to ${record}\n`);
    const body1 = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hello' }] });
    const body2 = JSON.stringify({ model: 'm', stream: true, system: 'make a title', messages: [{ role: 'user', content: 'hello again' }] });
    const body3 = 'nope';
    const [bytes1, bytes2, bytes3] = [body1, body2, body3].map((body) => Buffer.byteLength(body));
    expect(await post(handle.url, body1)).toBe(200);
    expect(await post(handle.url, body2)).toBe(200);
    expect(await post(handle.url, body3, '/other')).toBe(404);
    const { summary } = await handle.stop();
    expect(summary).toEqual({ scripted: 2, served: 1, repeated: 0, asides: 1, unmatched: 1, ambiguous: 0, invalid: 0, complete: true });
    const blocks = out.out.split('─'.repeat(60));
    expect(blocks).toHaveLength(5);
    const clock = '\\d\\d:\\d\\d:\\d\\d';
    expect(blocks[1]).toMatch(new RegExp(`^\\nreq 1  POST /v1/messages  200  scripted\\[0\\]  ${clock}\\n  messages 1   tools 0   total ${bytes1} B\\n$`));
    expect(blocks[2]).toMatch(new RegExp(`^\\nreq 2  POST /v1/messages  200  aside\\[0\\] title  ${clock}\\n  messages 1   tools 0   total ${bytes2} B   \\(\\+${bytes2! - bytes1!}\\)\\n$`));
    expect(blocks[3]).toMatch(new RegExp(`^\\nreq 3  POST /other  404  unmatched  ${clock}\\n  messages -   tools -   total ${bytes3} B   \\(-${bytes2! - bytes3!}\\)\\n$`));
    expect(blocks[4]).toBe(`\n${formatSummary(summary)}\nrecording: ${record}\n`);
    expect(readRecording(record).requests).toHaveLength(3);
  });

  test('--raw prints the body', async () => {
    const out = io();
    const handle = await startServe({ scenario: scenarioPath, port: 0, record: join(dir, 'raw.jsonl'), raw: true }, out);
    const body = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'raw please' }] });
    await post(handle.url, body);
    await handle.stop();
    expect(out.out).toContain(`\n  body ${body}\n`);
  });
});

const PRUNE_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), 'assert/fixtures/prune.jsonl');

describe('diff', () => {
  test('prints the divergence paths between two requests of one recording, one per line, and exits 0', () => {
    const out = io();
    expect(runDiff([PRUNE_FIXTURE, '1', '3'], out)).toBe(0);
    expect(out.err).toBe('');
    // Request 3 replaced the four archived messages with a placeholder and grew by two turns, so every
    // message content differs; message 1's content is a string on one side and an array on the other,
    // which is one leaf.
    expect(out.out).toBe(['$.messages[0].content', '$.messages[1].content', '$.messages[2].content', '$.messages[3].content', '$.messages[4].content', ''].join('\n'));
    const between = io();
    expect(runDiff([PRUNE_FIXTURE, '1', '2'], between)).toBe(0);
    expect(between.out).toBe('$.messages[5]\n$.messages[6]\n');
  });

  test('says so when the two requests are identical', () => {
    const out = io();
    expect(runDiff([PRUNE_FIXTURE, '2', '2'], out)).toBe(0);
    expect(out.out).toBe('request 2 and request 2 are identical\n');
  });

  test('exits 2 with a message when a seq is absent', () => {
    const out = io();
    expect(runDiff([PRUNE_FIXTURE, '1', '9'], out)).toBe(2);
    expect(out.out).toBe('');
    expect(out.err).toBe(`request 9 is absent: recording ${PRUNE_FIXTURE} has 3 requests\n`);
  });

  test('exits 2 on a bad argument count, a non-integer, or an unreadable recording; --help exits 0', () => {
    expect(runDiff([PRUNE_FIXTURE, '1'], io())).toBe(2);
    const bad = io();
    expect(runDiff([PRUNE_FIXTURE, '1', 'x'], bad)).toBe(2);
    expect(bad.err).toContain('request numbers must be positive integers, got "1" and "x"');
    expect(runDiff([PRUNE_FIXTURE, '0', '1'], io())).toBe(2);
    const missing = io();
    expect(runDiff([join(dir, 'missing.jsonl'), '1', '2'], missing)).toBe(2);
    expect(missing.err).toContain('ENOENT');
    const notARecording = join(dir, 'not-a-recording.jsonl');
    writeFileSync(notARecording, '{"type":"summary"}\n');
    const malformed = io();
    expect(runDiff([notARecording, '1', '2'], malformed)).toBe(2);
    expect(malformed.err).toContain('first line must be a run line');
    const help = io();
    expect(runDiff(['--help'], help)).toBe(0);
    expect(help.out).toContain('Usage: llmdouble diff');
  });
});

describe('main', () => {
  test('serve --help prints the serve usage and exits 0', async () => {
    const out = io();
    expect(await main(['serve', '--help'], out, () => Promise.resolve())).toBe(0);
    expect(out.out).toContain('Usage: llmdouble serve --scenario <file.json>');
    expect(out.out).toContain('--raw');
    expect(out.err).toBe('');
  });

  test('no command exits 2 with usage; --help exits 0', async () => {
    const out = io();
    expect(await main([], out, () => Promise.resolve())).toBe(2);
    expect(out.out).toContain('Usage:');
    expect(await main(['--help'], io(), () => Promise.resolve())).toBe(0);
  });

  test('diff routes to runDiff', async () => {
    const out = io();
    expect(await main(['diff', PRUNE_FIXTURE, '1', '1'], out, () => Promise.resolve())).toBe(0);
    expect(out.out).toBe('request 1 and request 1 are identical\n');
  });

  test('unknown command and bad serve flags exit 2', async () => {
    const out = io();
    expect(await main(['frobnicate'], out, () => Promise.resolve())).toBe(2);
    expect(out.err).toContain('unknown command: frobnicate');
    const bad = io();
    expect(await main(['serve'], bad, () => Promise.resolve())).toBe(2);
    expect(bad.err).toContain('--scenario is required');
  });

  test('a bad scenario file exits 1 with the validation message, no stack trace', async () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ responses: [{ say: 1 }] }));
    const out = io();
    expect(await main(['serve', '--scenario', bad], out, () => Promise.resolve())).toBe(1);
    expect(out.err).toBe(`${bad}: responses[0].say must be a string\n`);
  });

  test('serve runs until the stop signal, then prints the summary and exits 0', async () => {
    const out = io();
    const record = join(dir, 'main.jsonl');
    let release: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = main(['serve', '--scenario', scenarioPath, '--record', record], out, () => stopped);
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (out.out.includes('listening on ')) resolve();
        else setTimeout(poll, 5);
      };
      poll();
    });
    const url = /listening on (\S+)/.exec(out.out)![1]!;
    await post(url, JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] }));
    release();
    expect(await running).toBe(0);
    expect(out.out).toContain('2 scripted, 1 served, 0 repeated');
    expect(readRecording(record).summary?.served).toBe(1);
  });

  test('main rejects promptly when the server fails, without waiting for a stop signal', async () => {
    const out = io();
    const gone = join(dir, 'gone');
    const running = main(['serve', '--scenario', scenarioPath, '--record', join(gone, 'main.jsonl')], out, () => new Promise(() => undefined));
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        if (out.out.includes('listening on ')) resolve();
        else setTimeout(poll, 5);
      };
      poll();
    });
    const url = /listening on (\S+)/.exec(out.out)![1]!;
    const outcome = expect(running).rejects.toThrow(/server failed: .*ENOENT.*has no summary/);
    rmSync(gone, { recursive: true, force: true });
    await post(url, JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] })).catch(() => undefined);
    await outcome;
  });
});
