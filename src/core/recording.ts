// The JSONL recording (epic C3): one `run` line on open, one `request` line
// per request in receipt order, one `summary` line on close.
//
// Lines are appended as they happen; a crash mid-run leaves a readable file
// without a summary, and `readRecording` tolerates that.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { dirname } from 'node:path';
import type { NormalizedRequest } from './normalize.js';

export type SurfaceName = 'anthropic' | 'openai';

export type ServedKind = 'scripted' | 'aside' | 'repeated' | 'unmatched' | 'ambiguous' | 'invalid';

export interface RunLine {
  type: 'run';
  format: 1;
  startedAt: string;
  url: string;
  scenario: string | null;
}

export interface Served {
  kind: ServedKind;
  /** Position in `responses[]` (or `aside[]` for an aside); null for unmatched, ambiguous, and invalid. */
  index: number | null;
  /** The aside's name when `kind` is `aside`; otherwise null. */
  aside: string | null;
}

export interface RequestLine {
  type: 'request';
  seq: number;
  at: string;
  method: string;
  path: string;
  surface: SurfaceName | null;
  status: number;
  served: Served;
  /** Lowercased; `authorization`, `x-api-key`, `cookie`, `proxy-authorization` values are `[redacted]`. */
  headers: Record<string, string>;
  /** The exact request body string; never redacted. Empty for a 413, whose bytes are not retained. */
  body: string;
  /** null when the body could not be parsed by the surface. */
  normalized: NormalizedRequest | null;
  /** The exact response body string: SSE text when streamed, JSON otherwise. */
  responseBody: string;
}

export interface RunSummary {
  /** How many responses the scenario scripts. */
  scripted: number;
  /** Requests answered from the main sequence: `scripted` plus `repeated` kinds. */
  served: number;
  repeated: number;
  asides: number;
  unmatched: number;
  ambiguous: number;
  invalid: number;
}

export interface SummaryLine extends RunSummary {
  type: 'summary';
}

export type RecordingLine = RunLine | RequestLine | SummaryLine;

export interface RecordingFile {
  run: RunLine;
  requests: RequestLine[];
  /** null when the run did not close cleanly. */
  summary: SummaryLine | null;
}

export const RECORDING_FORMAT = 1;

export const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'proxy-authorization',
]);

/** Lowercase every header name and replace credential-bearing values with `[redacted]`. */
export function redactHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    out[key] = REDACTED_HEADERS.has(key) ? '[redacted]' : Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export interface OpenRecordingOptions {
  path: string;
  url: string;
  /** The scenario file path, or null when the scenario was passed inline. */
  scenario: string | null;
  /** `responses.length` of the scenario: the `scripted` count. */
  scripted: number;
}

/** Create (truncating) the recording file and write its `run` line. */
export function openRecording(options: OpenRecordingOptions): RecordingWriter {
  return new RecordingWriter(options);
}

export class RecordingWriter {
  readonly path: string;
  readonly run: RunLine;
  private readonly counts: RunSummary;
  private closed = false;

  constructor(options: OpenRecordingOptions) {
    this.path = options.path;
    this.run = {
      type: 'run',
      format: RECORDING_FORMAT,
      startedAt: new Date().toISOString(),
      url: options.url,
      scenario: options.scenario,
    };
    this.counts = { scripted: options.scripted, served: 0, repeated: 0, asides: 0, unmatched: 0, ambiguous: 0, invalid: 0 };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.run)}\n`);
  }

  /** Append one request line and tally its served kind. */
  request(line: Omit<RequestLine, 'type'>): RequestLine {
    if (this.closed) throw new Error(`recording ${this.path} is closed`);
    const full: RequestLine = { type: 'request', ...line };
    switch (full.served.kind) {
      case 'scripted':
        this.counts.served += 1;
        break;
      case 'repeated':
        this.counts.served += 1;
        this.counts.repeated += 1;
        break;
      case 'aside':
        this.counts.asides += 1;
        break;
      case 'unmatched':
        this.counts.unmatched += 1;
        break;
      case 'ambiguous':
        this.counts.ambiguous += 1;
        break;
      case 'invalid':
        this.counts.invalid += 1;
        break;
    }
    appendFileSync(this.path, `${JSON.stringify(full)}\n`);
    return full;
  }

  /** The counts so far. */
  get summary(): RunSummary {
    return { ...this.counts };
  }

  /** Write the `summary` line. Returns the counts; a second close is a no-op. */
  close(): RunSummary {
    if (!this.closed) {
      this.closed = true;
      const line: SummaryLine = { type: 'summary', ...this.counts };
      appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    }
    return this.summary;
  }
}

/** Parse a recording file. Tolerates a missing `summary` line (an unclean close); rejects anything else malformed. */
export function readRecording(path: string): RecordingFile {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line, i) => parseLine(path, line, i + 1));
  const [first, ...rest] = lines;
  if (first === undefined || first.type !== 'run') throw new Error(`${path}: first line must be a run line`);
  if (first.format !== RECORDING_FORMAT) throw new Error(`${path}: unsupported recording format ${first.format}`);
  const file: RecordingFile = { run: first, requests: [], summary: null };
  rest.forEach((line, i) => {
    if (line.type === 'request') {
      if (file.summary !== null) throw new Error(`${path}: line ${i + 2}: request line after the summary`);
      file.requests.push(line);
    } else if (line.type === 'summary') {
      if (file.summary !== null) throw new Error(`${path}: line ${i + 2}: second summary line`);
      file.summary = line;
    } else {
      throw new Error(`${path}: line ${i + 2}: second run line`);
    }
  });
  return file;
}

function parseLine(path: string, text: string, lineNumber: number): RecordingLine {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: line ${lineNumber}: not valid JSON: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path}: line ${lineNumber}: not an object`);
  }
  const type = (value as { type?: unknown }).type;
  if (type !== 'run' && type !== 'request' && type !== 'summary') {
    throw new Error(`${path}: line ${lineNumber}: unknown line type ${JSON.stringify(type)}`);
  }
  return value as RecordingLine;
}
