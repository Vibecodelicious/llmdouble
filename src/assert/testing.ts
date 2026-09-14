// Test support for the assertion suites: build recordings in memory from a
// compact message spec, with the raw Anthropic body and the normalised view
// written side by side. Hand-written on purpose: the reader's tests must not
// depend on the surface that writes real recordings (the import boundary);
// `src/fixtures/prune.test.ts` is where writer and reader are proven to agree.

import type { RecordingFile, RequestLine, Served } from '../core/recording.js';
import type { NormalizedBlock, NormalizedMessage } from '../core/normalize.js';
import { Recording } from './recording.js';

export type BlockSpec =
  | string
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'image'; source: { data: string } };

export interface MessageSpec {
  role: string;
  content: string | BlockSpec[];
}

export interface LineSpec {
  seq?: number;
  messages?: MessageSpec[];
  system?: string;
  tools?: string[];
  model?: string;
  served?: Served;
  status?: number;
  /** Raw body override (for un-normalised requests); `normalized` becomes null. */
  body?: string;
  headers?: Record<string, string>;
}

/** One request line whose `body` and `normalized` describe the same wire message. */
export function line(spec: LineSpec, seq = spec.seq ?? 1): RequestLine {
  const served = spec.served ?? { kind: 'scripted', index: seq - 1, aside: null };
  const base = {
    type: 'request' as const,
    seq,
    at: '2026-09-13T00:00:00.000Z',
    method: 'POST',
    path: '/v1/messages',
    surface: 'anthropic' as const,
    status: spec.status ?? 200,
    served,
    headers: spec.headers ?? { 'content-type': 'application/json' },
    responseBody: '',
  };
  if (spec.body !== undefined) return { ...base, body: spec.body, normalized: null };
  const messages = spec.messages ?? [{ role: 'user', content: 'hello' }];
  const wire: Record<string, unknown> = { model: spec.model ?? 'claude-test', max_tokens: 1024, stream: true };
  if (spec.system !== undefined) wire.system = spec.system;
  wire.messages = messages.map(wireMessage);
  if (spec.tools !== undefined) wire.tools = spec.tools.map((name) => ({ name, input_schema: { type: 'object' } }));
  return {
    ...base,
    body: JSON.stringify(wire),
    normalized: {
      model: spec.model ?? 'claude-test',
      stream: true,
      maxTokens: 1024,
      system: spec.system === undefined ? [] : [{ text: spec.system }],
      messages: messages.map(normalizedMessage),
      tools: (spec.tools ?? []).map((name) => ({ name })),
    },
  };
}

/** A recording with one line per spec, seqs 1..n, and a summary line unless `summary: false`. */
export function recording(specs: LineSpec[], options: { summary?: boolean; scripted?: number } = {}): Recording {
  return new Recording(recordingFile(specs, options));
}

export function recordingFile(specs: LineSpec[], options: { summary?: boolean; scripted?: number } = {}): RecordingFile {
  const requests = specs.map((spec, i) => line(spec, spec.seq ?? i + 1));
  const counts = { scripted: options.scripted ?? specs.length, served: 0, repeated: 0, asides: 0, unmatched: 0, ambiguous: 0, invalid: 0 };
  for (const { served } of requests) {
    if (served.kind === 'scripted') counts.served += 1;
    if (served.kind === 'repeated') {
      counts.served += 1;
      counts.repeated += 1;
    }
    if (served.kind === 'aside') counts.asides += 1;
    if (served.kind === 'unmatched') counts.unmatched += 1;
    if (served.kind === 'ambiguous') counts.ambiguous += 1;
    if (served.kind === 'invalid') counts.invalid += 1;
  }
  return {
    run: { type: 'run', format: 1, startedAt: '2026-09-13T00:00:00.000Z', url: 'http://127.0.0.1:1', scenario: null },
    requests,
    summary: options.summary === false ? null : { type: 'summary', ...counts },
  };
}

/** The JSONL text of a recording file, for tests that go through `load`. */
export function jsonl(file: RecordingFile): string {
  const lines: unknown[] = [file.run, ...file.requests];
  if (file.summary !== null) lines.push(file.summary);
  return lines.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

function wireMessage(message: MessageSpec): unknown {
  if (typeof message.content === 'string') return { role: message.role, content: message.content };
  return {
    role: message.role,
    content: message.content.map((block) => (typeof block === 'string' ? { type: 'text', text: block } : block)),
  };
}

function normalizedMessage(message: MessageSpec): NormalizedMessage {
  const blocks = typeof message.content === 'string' ? [message.content] : message.content;
  return { role: message.role, content: blocks.map(normalizedBlock) };
}

function normalizedBlock(block: BlockSpec): NormalizedBlock {
  if (typeof block === 'string') return { type: 'text', text: block };
  switch (block.type) {
    case 'text':
      return block;
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return { type: 'tool_result', toolUseId: block.tool_use_id, text: block.content };
    case 'image':
      return { type: 'text', text: JSON.stringify(block) };
  }
}
