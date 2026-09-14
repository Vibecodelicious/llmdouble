import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { readRecording, type RequestLine } from './recording.js';
import type { Scenario } from './scenario.js';
import { MAX_BODY_BYTES, startServer, type ServerHandle } from './server.js';
import { parseSse } from './sse.js';

const dir = mkdtempSync(join(tmpdir(), 'llmdouble-server-'));
let counter = 0;

const scenario: Scenario = {
  responses: [
    { say: 'first', usage: { input: 10, output: 1 } },
    { say: 'second', calls: [{ tool: 'read_file', with: { path: 'a.ts' } }], usage: { input: 20, output: 2 } },
    { say: 'third', usage: { input: 30, output: 3 } },
  ],
  aside: [
    { name: 'title', when: { system: { contains: 'Generate a short, descriptive title' } }, say: 'Untitled' },
    { name: 'haiku-no-tools', when: { model: { endsWith: '-haiku' }, tools: { absent: true } }, say: 'aside two' },
  ],
};

interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface SendInit {
  method?: string;
  path?: string;
  body?: string;
  headers?: Record<string, string>;
}

function send(url: string, init: SendInit = {}): Promise<Response> {
  const { port } = new URL(url);
  const body = init.body ?? '';
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: init.method ?? 'POST',
        path: init.path ?? '/v1/messages',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...init.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function messages(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model: 'claude-sonnet-4-6', stream: true, max_tokens: 1024, messages: [{ role: 'user', content: text }], ...extra });
}

const open: ServerHandle[] = [];
async function start(options: Partial<Parameters<typeof startServer>[0]> = {}): Promise<ServerHandle> {
  const record = join(dir, `run-${++counter}.jsonl`);
  const handle = await startServer({ scenario, record, ...options });
  open.push(handle);
  return handle;
}
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

function textOf(sse: string): string {
  const delta = parseSse(sse).find((e) => e.event === 'content_block_delta')?.data as { delta: { text?: string } } | undefined;
  return delta?.delta.text ?? '';
}

describe('startServer', () => {
  test('binds 127.0.0.1 on an ephemeral port and close() returns the recording loaded back from the file', async () => {
    const server = await start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(new URL(server.url).port).not.toBe('0');
    const recording = await open.pop()!.close();
    expect(recording.path).toBe(server.recordPath);
    expect(recording.count).toBe(0);
    expect(recording.summary).toEqual({ scripted: 3, served: 0, repeated: 0, asides: 0, unmatched: 0, ambiguous: 0, invalid: 0, complete: true });
    const file = readRecording(server.recordPath);
    expect(file.run.url).toBe(server.url);
    expect(file.run.scenario).toBeNull();
    expect(recording.run).toEqual(file.run);
    const { complete: _complete, ...counts } = recording.summary;
    expect(file.summary).toEqual({ type: 'summary', ...counts });
  });

  test('close() releases the port', async () => {
    const server = await start();
    const { port } = new URL(server.url);
    await open.pop()!.close();
    const canBind = await new Promise<boolean>((resolve) => {
      const guard = createServer();
      guard.once('error', () => resolve(false));
      guard.listen(Number(port), '127.0.0.1', () => guard.close(() => resolve(true)));
    });
    expect(canBind).toBe(true);
  });

  test('refuses any host but 127.0.0.1', async () => {
    await expect(startServer({ scenario, host: '0.0.0.0' as '127.0.0.1' })).rejects.toThrow('binds loopback only');
    await expect(startServer({ scenario, host: 'localhost' as '127.0.0.1' })).rejects.toThrow('binds loopback only');
  });

  test('honours an explicit port', async () => {
    const probe = await start();
    const { port } = new URL(probe.url);
    await open.pop()!.close();
    const server = await start({ port: Number(port) });
    expect(new URL(server.url).port).toBe(port);
  });

  test('loads a scenario from a file and records its path', async () => {
    const path = join(dir, 'scenario.json');
    writeFileSync(path, JSON.stringify(scenario));
    const server = await start({ scenario: path });
    expect(readRecording(server.recordPath).run.scenario).toBe(path);
  });

  test('a scenario error surfaces as a ScenarioError, not a listening server', async () => {
    await expect(startServer({ scenario: { responses: [] } })).rejects.toThrow('responses must not be empty');
  });

  test('defaults the recording to a temp file', async () => {
    const server = await startServer({ scenario });
    open.push(server);
    expect(server.recordPath.startsWith(tmpdir())).toBe(true);
    expect(server.recordPath).toMatch(/llmdouble-.*\.jsonl$/);
  });
});

describe('main sequence', () => {
  test('serves scripted responses in order, then repeats the last one', async () => {
    const lines: RequestLine[] = [];
    const server = await start({ onRequest: (line) => lines.push(line) });
    const replies: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await send(server.url, { body: messages(`turn ${i}`) });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      replies.push(textOf(res.body));
    }
    expect(replies).toEqual(['first', 'second', 'third', 'third', 'third']);
    expect(lines.map((line) => line.served)).toEqual([
      { kind: 'scripted', index: 0, aside: null },
      { kind: 'scripted', index: 1, aside: null },
      { kind: 'scripted', index: 2, aside: null },
      { kind: 'repeated', index: 2, aside: null },
      { kind: 'repeated', index: 2, aside: null },
    ]);
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3, 4, 5]);
    const { summary } = await open.pop()!.close();
    expect(summary).toEqual({ scripted: 3, served: 5, repeated: 2, asides: 0, unmatched: 0, ambiguous: 0, invalid: 0, complete: true });
  });

  test('streams the exact SSE lifecycle with scripted usage and monotonic ids', async () => {
    const server = await start();
    const res1 = await send(server.url, { body: messages('one') });
    const res2 = await send(server.url, { body: messages('two', { tools: [{ name: 'read_file' }] }) });
    const events1 = parseSse(res1.body);
    expect(events1.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const start1 = events1[0]!.data as { message: { id: string; usage: { input_tokens: number } } };
    expect(start1.message.id).toBe('msg_1');
    expect(start1.message.usage.input_tokens).toBe(10);
    const delta1 = events1[4]!.data as { delta: { stop_reason: string }; usage: { output_tokens: number } };
    expect(delta1.delta.stop_reason).toBe('end_turn');
    expect(delta1.usage.output_tokens).toBe(1);

    const events2 = parseSse(res2.body);
    expect(events2.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect((events2[0]!.data as { message: { id: string } }).message.id).toBe('msg_2');
    expect((events2[4]!.data as { content_block: { id: string; name: string } }).content_block).toMatchObject({ id: 'toolu_1', name: 'read_file' });
    expect((events2[5]!.data as { delta: { partial_json: string } }).delta.partial_json).toBe('{"path":"a.ts"}');
    expect((events2[7]!.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe('tool_use');
  });
});

describe('asides', () => {
  test('a matching aside is served without advancing the cursor and recorded with its name', async () => {
    const server = await start();
    const title = await send(server.url, { body: messages('x', { system: 'Generate a short, descriptive title for this conversation' }) });
    expect(title.status).toBe(200);
    expect(textOf(title.body)).toBe('Untitled');
    const main = await send(server.url, { body: messages('real turn') });
    expect(textOf(main.body)).toBe('first');
    const byModel = await send(server.url, { body: messages('bg', { model: 'claude-3-5-haiku' }) });
    expect(textOf(byModel.body)).toBe('aside two');
    const { summary } = await open.pop()!.close();
    expect(summary).toEqual({ scripted: 3, served: 1, repeated: 0, asides: 2, unmatched: 0, ambiguous: 0, invalid: 0, complete: true });
    const file = readRecording(server.recordPath);
    expect(file.requests.map((line) => line.served)).toEqual([
      { kind: 'aside', index: 0, aside: 'title' },
      { kind: 'scripted', index: 0, aside: null },
      { kind: 'aside', index: 1, aside: 'haiku-no-tools' },
    ]);
  });

  test('two matching asides yield 500 ambiguous_match and do not advance the cursor', async () => {
    const server = await start();
    const res = await send(server.url, {
      body: messages('x', { model: 'claude-3-5-haiku', system: 'Generate a short, descriptive title' }),
    });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ type: 'error', error: { type: 'ambiguous_match', message: expect.stringContaining('More than one aside') } });
    expect(textOf((await send(server.url, { body: messages('next') })).body)).toBe('first');
    const { summary } = await open.pop()!.close();
    expect(summary.ambiguous).toBe(1);
    const [line] = readRecording(server.recordPath).requests;
    expect(line!.served).toEqual({ kind: 'ambiguous', index: null, aside: null });
    expect(line!.status).toBe(500);
    expect(line!.normalized?.model).toBe('claude-3-5-haiku');
  });
});

describe('error matrix', () => {
  test.each<[string, SendInit, number, string, RequestLine['served']['kind'], string | null]>([
    ['stream: false', { body: messages('x', { stream: false }) }, 422, 'stream_required', 'invalid', 'anthropic'],
    ['unknown path', { path: '/v1/complete', body: messages('x') }, 404, 'not_found', 'unmatched', null],
    ['non-POST', { method: 'GET' }, 405, 'method_not_allowed', 'unmatched', 'anthropic'],
    ['unparseable JSON', { body: '{not json' }, 400, 'invalid_json', 'invalid', 'anthropic'],
    ['JSON that is not an object', { body: '[1,2]' }, 400, 'invalid_json', 'invalid', 'anthropic'],
    ['empty body', { body: '' }, 400, 'invalid_json', 'invalid', 'anthropic'],
    ['missing model', { body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x' }] }) }, 400, 'invalid_request', 'invalid', 'anthropic'],
  ])('%s', async (_label, init, status, type, kind, surface) => {
    const server = await start();
    const res = await send(server.url, init);
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toBe('application/json');
    const body = JSON.parse(res.body) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe(type);
    expect(typeof body.error.message).toBe('string');
    const { summary } = await open.pop()!.close();
    expect(summary.served).toBe(0);
    const [line] = readRecording(server.recordPath).requests;
    expect(line).toMatchObject({ seq: 1, status, surface, served: { kind, index: null, aside: null }, responseBody: res.body });
    expect(line!.body).toBe(init.body ?? '');
    expect(line!.normalized).toBeNull();
  });

  test('a body over 8 MiB is 413, recorded as invalid with an empty body', async () => {
    const server = await start();
    const res = await send(server.url, { body: 'x'.repeat(MAX_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error.type).toBe('request_too_large');
    const exact = await send(server.url, { body: `{"pad":"${'x'.repeat(MAX_BODY_BYTES - 10)}"}` });
    expect(exact.status).toBe(400);
    await open.pop()!.close();
    const [line, second] = readRecording(server.recordPath).requests;
    expect(line).toMatchObject({ status: 413, served: { kind: 'invalid', index: null, aside: null }, body: '', normalized: null });
    expect(second!.status).toBe(400);
  }, 60000);

  test('rejections still advance seq without gaps', async () => {
    const server = await start();
    await send(server.url, { path: '/nope' });
    await send(server.url, { body: messages('a') });
    await send(server.url, { body: '{' });
    await send(server.url, { body: messages('b') });
    await open.pop()!.close();
    const lines = readRecording(server.recordPath).requests;
    expect(lines.map((line) => [line.seq, line.served.kind])).toEqual([
      [1, 'unmatched'],
      [2, 'scripted'],
      [3, 'invalid'],
      [4, 'scripted'],
    ]);
  });
});

describe('recorded lines', () => {
  test('carry redacted lowercased headers, the exact body, the normalised view, and the exact SSE text', async () => {
    const server = await start();
    const body = messages('help me refactor the parser', {
      system: [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'read_file', input_schema: {} }],
    });
    const res = await send(server.url, {
      body,
      headers: { 'X-Api-Key': 'sekret', Authorization: 'Bearer t', Cookie: 'a=b', 'Proxy-Authorization': 'p', 'Anthropic-Version': '2023-06-01' },
    });
    await open.pop()!.close();
    const [line] = readRecording(server.recordPath).requests;
    expect(line).toMatchObject({
      type: 'request',
      seq: 1,
      method: 'POST',
      path: '/v1/messages',
      surface: 'anthropic',
      status: 200,
      served: { kind: 'scripted', index: 0, aside: null },
      body,
      responseBody: res.body,
    });
    expect(new Date(line!.at).toISOString()).toBe(line!.at);
    expect(line!.headers).toMatchObject({
      'content-type': 'application/json',
      'x-api-key': '[redacted]',
      authorization: '[redacted]',
      cookie: '[redacted]',
      'proxy-authorization': '[redacted]',
      'anthropic-version': '2023-06-01',
    });
    expect(Object.keys(line!.headers).every((key) => key === key.toLowerCase())).toBe(true);
    expect(line!.body).toContain('cache_control');
    expect(line!.normalized).toEqual({
      model: 'claude-sonnet-4-6',
      stream: true,
      maxTokens: 1024,
      system: [{ text: 'You are helpful.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'help me refactor the parser' }] }],
      tools: [{ name: 'read_file' }],
    });
    expect(line!.normalized!.messages).toHaveLength((JSON.parse(body) as { messages: unknown[] }).messages.length);
    expect(parseSse(line!.responseBody).map((e) => e.event)).toContain('message_stop');
  });
});

describe('handler failures', () => {
  function listeners(): number {
    return process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
  }

  test('a throwing onRequest fails the server: onError, a reset client, refused requests, close() throws, no summary', async () => {
    const errors: Error[] = [];
    const server = await start({
      onRequest: (line) => {
        if (line.seq === 2) throw new Error('boom');
      },
      onError: (error) => errors.push(error),
    });
    expect((await send(server.url, { body: messages('one') })).status).toBe(200);
    await expect(send(server.url, { body: messages('two') })).rejects.toThrow(/ECONNRESET|socket hang up/);
    expect(errors.map((e) => e.message)).toEqual(['boom']);
    await expect(send(server.url, { body: messages('three') })).rejects.toThrow(/ECONNRESET|socket hang up/);
    expect(errors).toHaveLength(1);
    await expect(open.pop()!.close()).rejects.toThrow('boom');
    const file = readRecording(server.recordPath);
    expect(file.requests.map((line) => line.seq)).toEqual([1, 2]);
    expect(file.summary).toBeNull();
  });

  test('a recording that cannot be appended fails the server and close() throws', async () => {
    const gone = join(dir, `gone-${++counter}`);
    const errors: Error[] = [];
    const server = await start({ record: join(gone, 'run.jsonl'), onError: (error) => errors.push(error) });
    rmSync(gone, { recursive: true, force: true });
    await expect(send(server.url, { body: messages('one') })).rejects.toThrow(/ECONNRESET|socket hang up/);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('ENOENT');
    await expect(open.pop()!.close()).rejects.toThrow('ENOENT');
  });

  test('a recording that cannot be opened rejects startServer without leaving a listener behind', async () => {
    const before = listeners();
    const file = join(dir, `not-a-dir-${++counter}`);
    writeFileSync(file, '');
    await expect(startServer({ scenario, record: join(file, 'run.jsonl') })).rejects.toThrow(/ENOTDIR|EEXIST/);
    // A closed listener leaves the active-resources list a loop turn or two after its close callback; a leaked one never does.
    const deadline = Date.now() + 1000;
    while (listeners() > before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(listeners()).toBeLessThanOrEqual(before);
  });
});
