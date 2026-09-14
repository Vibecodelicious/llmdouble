#!/usr/bin/env node
// Generates src/assert/fixtures/prune.jsonl: a three-request conversation
// recorded by the real server, in which a client archives four messages
// (one carrying a secret) between request 2 and request 3. It is the
// fixture behind src/assert/design-5-0.test.ts and the writer/reader
// agreement test in prune.test.ts.
//
// Regenerate after a change to the recording format or the surface:
//
//   npm run fixtures        (builds, then runs this file)
//
// Only `startedAt`, `url`, and each request's `at` vary between runs;
// prune.test.ts compares the checked-in file to a fresh recording with
// those masked, so a drift between the server and the fixture fails CI.

import { realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Recording } from '../assert/recording.js';
import type { Scenario } from '../core/scenario.js';
import { startServer } from '../core/server.js';

/** Where the checked-in fixture lives, relative to this module in src/ or dist/. */
export const PRUNE_FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/assert/fixtures/prune.jsonl');

/** The string that is on the wire in requests 1 and 2 and must be absent from request 3. */
export const PRUNE_SECRET = 'SECRET-TOKEN-4f9c';

export const PRUNE_SCENARIO: Scenario = {
  responses: [
    { say: "I'll read the parser first.", calls: [{ tool: 'read_file', with: { path: 'src/parser.ts' } }], usage: { input: 4200, output: 180 } },
    { say: 'The parser handles nested groups; nothing to change.', usage: { input: 4400, output: 60 } },
    { say: 'Four messages were archived; the parser is unchanged.', usage: { input: 1900, output: 40 } },
  ],
};

const SYSTEM = 'You are a careful editor.';

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

const ARCHIVED = [
  { role: 'user', content: `step one: read src/parser.ts. The deploy token is ${PRUNE_SECRET}.` },
  { role: 'assistant', content: 'step two: nested capture groups are handled at line 412.' },
  { role: 'user', content: 'step three: the tests pass.' },
  { role: 'assistant', content: 'step four: done.' },
];

const REFACTOR = { role: 'user', content: 'Now refactor the parser.' };

const TOOL_TURN = [
  { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/parser.ts' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export function parse(input: string) {}' }] },
];

const PLACEHOLDER = {
  role: 'user',
  content: [
    { type: 'text', text: '[PRUNED: 4 messages archived]' },
    { type: 'text', text: REFACTOR.content },
  ],
};

/** The three request bodies the client sends, in order: full, tool continuation, pruned. */
export const PRUNE_REQUESTS: unknown[] = [
  body([...ARCHIVED, REFACTOR]),
  body([...ARCHIVED, REFACTOR, ...TOOL_TURN]),
  body([PLACEHOLDER, ...TOOL_TURN, { role: 'assistant', content: PRUNE_SCENARIO.responses[1]!.say }, { role: 'user', content: 'Summarise what changed.' }]),
];

function body(messages: unknown[]): unknown {
  return { model: 'claude-sonnet-4-6', max_tokens: 1024, stream: true, system: SYSTEM, tools: TOOLS, messages };
}

/** Start the server, play the three requests, close, and return the recording written to `record`. */
export async function recordPruneFixture(record: string): Promise<Recording> {
  const server = await startServer({ scenario: PRUNE_SCENARIO, record });
  try {
    for (const request of PRUNE_REQUESTS) await post(server.url, JSON.stringify(request));
  } catch (error) {
    await server.close();
    throw error;
  }
  return server.close();
}

/** POST with fixed headers, so only the timestamps and the port differ between runs. */
function post(url: string, text: string): Promise<void> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/messages',
        headers: {
          host: '127.0.0.1',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
          'x-api-key': 'placeholder',
          'anthropic-version': '2023-06-01',
        },
      },
      (res) => {
        res.resume();
        res.once('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(`fixture request answered ${res.statusCode}`))));
      },
    );
    req.once('error', reject);
    req.end(text);
  });
}

/** The JSONL with the fields that vary between runs replaced, for comparing a fresh recording to the checked-in one. */
export function maskVolatile(jsonl: string): string {
  return jsonl
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === 'run') {
        value.startedAt = '<startedAt>';
        value.url = '<url>';
      }
      if (value.type === 'request') value.at = '<at>';
      return JSON.stringify(value);
    })
    .join('\n');
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const out = process.argv[2] ?? PRUNE_FIXTURE;
  recordPruneFixture(out).then(
    (recording) => process.stdout.write(`wrote ${out}: ${recording.count} requests\n`),
    (error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
