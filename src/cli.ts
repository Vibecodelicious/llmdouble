#!/usr/bin/env node
// The `llmdouble` command (epic C6).
//
//   llmdouble serve --scenario <file.json> [--port N] [--record <path.jsonl>] [--raw]
//   llmdouble diff <recording.jsonl> <N> <M>
//
// `serve` prints one block per request: seq, path, status, served kind,
// message count, tool count, total bytes, and the byte delta from the
// previous request. `--raw` also prints the body. `diff` prints the JSON
// paths at which two requests' bodies differ, one per line.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { diffBodies } from './assert/divergence.js';
import { load } from './assert/load.js';
import type { Recording } from './assert/recording.js';
import { BlockedError } from './assert/verdict.js';
import type { RequestLine, RunSummary } from './core/recording.js';
import { ScenarioError } from './core/scenario.js';
import { startServer } from './core/server.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const USAGE = `Usage:
  llmdouble serve --scenario <file.json> [--port N] [--record <path.jsonl>] [--raw]
  llmdouble diff <recording.jsonl> <N> <M>
`;

export const DIFF_USAGE = `Usage: llmdouble diff <recording.jsonl> <N> <M>

Print the JSON paths at which request N's body differs from request M's, one per line,
both requests taken from the one recording. Exits 0 whether or not they differ, and 2
when an argument is bad, the recording cannot be read, or a request number is absent.
`;

export const SERVE_USAGE = `Usage: llmdouble serve --scenario <file.json> [--port N] [--record <path.jsonl>] [--raw]

Serve scripted responses on 127.0.0.1 and record every request as JSONL.

Options:
  --scenario <file.json>   scenario file (required)
  --port N                 port to bind on 127.0.0.1 (default 0: ephemeral)
  --record <path.jsonl>    recording path (default ./llmdouble-<timestamp>.jsonl)
  --raw                    also print each request body
  -h, --help               show this help

Stop with Ctrl-C; the run summary is printed on exit.
`;

export interface ServeOptions {
  scenario: string;
  port: number;
  record: string;
  raw: boolean;
}

export type ServeArgs = { kind: 'run'; options: ServeOptions } | { kind: 'help' } | { kind: 'error'; message: string };

export function parseServeArgs(argv: string[]): ServeArgs {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof SERVE_FLAGS }>>;
  try {
    parsed = parseArgs({ args: argv, options: SERVE_FLAGS, allowPositionals: false, strict: true });
  } catch (error) {
    return { kind: 'error', message: (error as Error).message };
  }
  const { values } = parsed;
  if (values.help) return { kind: 'help' };
  if (values.scenario === undefined) return { kind: 'error', message: '--scenario is required' };
  let port = 0;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return { kind: 'error', message: `--port must be an integer between 0 and 65535, got ${JSON.stringify(values.port)}` };
    }
  }
  return {
    kind: 'run',
    options: { scenario: values.scenario, port, record: values.record ?? defaultRecordPath(), raw: values.raw ?? false },
  };
}

const SERVE_FLAGS = {
  scenario: { type: 'string' },
  port: { type: 'string' },
  record: { type: 'string' },
  raw: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

export function defaultRecordPath(now = new Date()): string {
  return `./llmdouble-${now.toISOString().replace(/[:.]/g, '-')}.jsonl`;
}

export interface ServeHandle {
  url: string;
  recordPath: string;
  /** Rejects with the server's handler failure, if one happens; `serve` exits 1 on it rather than serving nothing. */
  failed: Promise<never>;
  /** Close the server, print the run summary, and return the recording. */
  stop(): Promise<Recording>;
}

/** Start `serve`: print the listening line, then one block per request until `stop()`. */
export async function startServe(options: ServeOptions, io: CliIo): Promise<ServeHandle> {
  let previousBytes: number | null = null;
  let fail: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failed.catch(() => undefined); // observed through the handle; nothing to report here if the caller never races it
  const server = await startServer({
    scenario: options.scenario,
    port: options.port,
    record: options.record,
    onRequest: (line) => {
      io.stdout(formatRequestBlock(line, previousBytes, options.raw));
      previousBytes = byteLength(line.body);
    },
    onError: (error) => fail(new Error(`server failed: ${error.message}; recording ${server.recordPath} has no summary`)),
  });
  io.stdout(`listening on ${server.url}\nrecording to ${server.recordPath}\n`);
  return {
    url: server.url,
    recordPath: server.recordPath,
    failed,
    stop: async () => {
      const recording = await server.close();
      io.stdout(`${RULE}\n${formatSummary(recording.summary)}\nrecording: ${server.recordPath}\n`);
      return recording;
    },
  };
}

const RULE = '─'.repeat(60);

/** The per-request block `serve` prints. `previousBytes` is null for the first request. */
export function formatRequestBlock(line: RequestLine, previousBytes: number | null, raw = false): string {
  const bytes = byteLength(line.body);
  const served = line.served.kind === 'aside'
    ? `aside[${line.served.index}] ${line.served.aside}`
    : line.served.index === null
      ? line.served.kind
      : `${line.served.kind}[${line.served.index}]`;
  const delta = previousBytes === null ? '' : `   (${formatDelta(bytes - previousBytes)})`;
  const messages = line.normalized === null ? '-' : String(line.normalized.messages.length);
  const tools = line.normalized === null ? '-' : String(line.normalized.tools.length);
  let block = `${RULE}\nreq ${line.seq}  ${line.method} ${line.path}  ${line.status}  ${served}  ${clock(line.at)}\n`;
  block += `  messages ${messages}   tools ${tools}   total ${formatNumber(bytes)} B${delta}\n`;
  if (raw) block += `  body ${line.body}\n`;
  return block;
}

/** The one-line run summary: "3 scripted, 4 served, 1 repeated, ...". */
export function formatSummary(summary: RunSummary): string {
  return [
    `${summary.scripted} scripted`,
    `${summary.served} served`,
    `${summary.repeated} repeated`,
    `${summary.asides} asides`,
    `${summary.unmatched} unmatched`,
    `${summary.ambiguous} ambiguous`,
    `${summary.invalid} invalid`,
  ].join(', ');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatDelta(n: number): string {
  return n < 0 ? `-${formatNumber(-n)}` : `+${formatNumber(n)}`;
}

function clock(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Run the CLI. Resolves with the exit code; for `serve`, after `untilStop` settles. */
export async function main(argv: string[], io: CliIo, untilStop: () => Promise<void>): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    io.stdout(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === 'diff') return runDiff(rest, io);
  if (command !== 'serve') {
    io.stderr(`unknown command: ${command}\n${USAGE}`);
    return 2;
  }
  const args = parseServeArgs(rest);
  if (args.kind === 'help') {
    io.stdout(SERVE_USAGE);
    return 0;
  }
  if (args.kind === 'error') {
    io.stderr(`${args.message}\n${SERVE_USAGE}`);
    return 2;
  }
  let handle: ServeHandle;
  try {
    handle = await startServe(args.options, io);
  } catch (error) {
    io.stderr(`${error instanceof ScenarioError ? error.message : (error as Error).message}\n`);
    return 1;
  }
  await Promise.race([untilStop(), handle.failed]);
  await handle.stop();
  return 0;
}

/** `llmdouble diff <recording.jsonl> <N> <M>`: the differing paths between two requests of one recording. */
export function runDiff(args: string[], io: CliIo): number {
  if (args.includes('-h') || args.includes('--help')) {
    io.stdout(DIFF_USAGE);
    return 0;
  }
  if (args.length !== 3) {
    io.stderr(`diff takes a recording and two request numbers, got ${args.length} argument${args.length === 1 ? '' : 's'}\n${DIFF_USAGE}`);
    return 2;
  }
  const [path, ...numbers] = args as [string, string, string];
  const seqs = numbers.map(Number);
  if (seqs.some((n) => !Number.isInteger(n) || n < 1)) {
    io.stderr(`request numbers must be positive integers, got ${numbers.map((n) => JSON.stringify(n)).join(' and ')}\n${DIFF_USAGE}`);
    return 2;
  }
  const [n, m] = seqs as [number, number];
  let recording: Recording;
  try {
    recording = load(path);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n`);
    return 2;
  }
  let left: Recording['requests'][number];
  let right: Recording['requests'][number];
  try {
    left = recording.request(n);
    right = recording.request(m);
  } catch (error) {
    if (!(error instanceof BlockedError)) throw error;
    io.stderr(`${error.verdict.claim}\n`);
    return 2;
  }
  const paths = diffBodies(left.raw.body, right.raw.body);
  io.stdout(paths.length === 0 ? `request ${n} and request ${m} are identical\n` : paths.map((p) => `${p}\n`).join(''));
  return 0;
}

function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
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
  const io: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
  main(process.argv.slice(2), io, untilSignal).then(
    (code) => process.exit(code),
    (error: unknown) => {
      io.stderr(`${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}
