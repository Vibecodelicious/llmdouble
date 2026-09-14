// The loopback HTTP server (epic C5): routes each request to a surface,
// evaluates asides, advances the scenario cursor, renders the response, and
// records every request, including the ones it rejects.
//
// Every request that is fully received gets a `seq` in strict receipt order;
// the decision and the recording happen in one synchronous step, so
// concurrent clients cannot interleave the cursor or the ids.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from '../assert/load.js';
import type { Recording } from '../assert/recording.js';
import { anthropicSurface } from '../surfaces/anthropic.js';
import { IdCounters } from './ids.js';
import { matchesWhen } from './matcher.js';
import type { NormalizedRequest } from './normalize.js';
import { openRecording, redactHeaders, type RequestLine, type RunSummary, type Served, type SurfaceName } from './recording.js';
import { loadScenario, validateScenario, type Scenario, type ScriptedResponse } from './scenario.js';

export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface ErrorSpec {
  status: number;
  type: string;
  message: string;
}

export type ParseResult = { ok: true; normalized: NormalizedRequest } | { ok: false; error: ErrorSpec };

export interface RenderContext {
  normalized: NormalizedRequest;
  ids: IdCounters;
}

export interface Rendered {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** One provider wire format. The server owns routing, the body limit, JSON parsing, asides, the cursor, and recording. */
export interface Surface {
  name: SurfaceName;
  path: string;
  /** Validate a JSON object body. A failure is served as its `error` and recorded as `invalid`. */
  parse(body: Record<string, unknown>): ParseResult;
  /** Render a scripted response (a main-sequence response or an aside) for this surface. */
  render(response: ScriptedResponse, ctx: RenderContext): Rendered;
}

const SURFACES: readonly Surface[] = [anthropicSurface];

const KNOWN_ROUTES = SURFACES.map((surface) => `POST ${surface.path}`).join(', ');

export const SERVER_ERRORS = {
  invalidJson: { status: 400, type: 'invalid_json', message: 'Request body must be a JSON object.' },
  requestTooLarge: { status: 413, type: 'request_too_large', message: `Request body exceeds ${MAX_BODY_BYTES} bytes.` },
  methodNotAllowed: { status: 405, type: 'method_not_allowed', message: `Only ${KNOWN_ROUTES} is supported.` },
  notFound: { status: 404, type: 'not_found', message: `Only ${KNOWN_ROUTES} is supported.` },
  ambiguousMatch: { status: 500, type: 'ambiguous_match', message: 'More than one aside matched this request.' },
} as const satisfies Record<string, ErrorSpec>;

export interface StartServerOptions {
  /** A scenario file path, or an inline scenario (recorded as `scenario: null`). */
  scenario: string | Scenario;
  /** Default 0: an ephemeral port. */
  port?: number;
  /** The server binds loopback only; any other value is refused. */
  host?: '127.0.0.1';
  /** The JSONL recording path. Default: a file under the OS temp directory. */
  record?: string;
  /** Called with each request line as it is recorded. */
  onRequest?: (line: RequestLine) => void;
}

export interface ServerHandle {
  url: string;
  recordPath: string;
  /** Stop listening, write the summary line, and return the recording, loaded back from the file (epic C5). */
  close(): Promise<Recording>;
}

export async function startServer(options: StartServerOptions): Promise<ServerHandle> {
  if (options.host !== undefined && options.host !== '127.0.0.1') {
    throw new Error(`llmdouble binds loopback only; refusing host ${JSON.stringify(options.host)}`);
  }
  const scenarioPath = typeof options.scenario === 'string' ? options.scenario : null;
  const scenario = scenarioPath === null ? validateScenario(options.scenario) : loadScenario(scenarioPath);
  const engine = new Engine(scenario, options.onRequest);
  const server = createServer((req, res) => {
    void engine.handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('server did not start with a socket address');
  }
  const url = `http://127.0.0.1:${address.port}`;
  const recordPath = options.record ?? defaultRecordPath();
  engine.open({ path: recordPath, url, scenario: scenarioPath, scripted: scenario.responses.length });
  return {
    url,
    recordPath,
    close: () => closeServer(server, engine, recordPath),
  };
}

function defaultRecordPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(tmpdir(), `llmdouble-${stamp}-${process.pid}.jsonl`);
}

async function closeServer(server: Server, engine: Engine, recordPath: string): Promise<Recording> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  engine.close();
  return load(recordPath);
}

type ReceivedBody = { oversized: false; text: string } | { oversized: true };

/** Scenario cursor, ids, and recording for one server instance. */
class Engine {
  private readonly ids = new IdCounters();
  private cursor = 0;
  private seq = 0;
  private recording: ReturnType<typeof openRecording> | null = null;

  constructor(
    private readonly scenario: Scenario,
    private readonly onRequest: ((line: RequestLine) => void) | undefined,
  ) {}

  open(options: Parameters<typeof openRecording>[0]): void {
    this.recording = openRecording(options);
  }

  close(): RunSummary {
    if (this.recording === null) throw new Error('recording was never opened');
    return this.recording.close();
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let received: ReceivedBody;
    try {
      received = await readBody(req);
    } catch {
      return; // the client went away mid-upload; there is nothing to answer or record
    }
    // Everything below is synchronous: one request's decision, recording, and reply cannot interleave with another's.
    const seq = ++this.seq;
    const at = new Date().toISOString();
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const surface = SURFACES.find((candidate) => candidate.path === path) ?? null;
    const outcome = this.decide(received, surface, method);
    const line = this.recording?.request({
      seq,
      at,
      method,
      path,
      surface: surface?.name ?? null,
      status: outcome.rendered.status,
      served: outcome.served,
      headers: redactHeaders(req.headers),
      body: received.oversized ? '' : received.text,
      normalized: outcome.normalized,
      responseBody: outcome.rendered.body,
    });
    if (line !== undefined) this.onRequest?.(line);
    res.writeHead(outcome.rendered.status, outcome.rendered.headers);
    res.end(outcome.rendered.body);
  }

  private decide(
    received: ReceivedBody,
    surface: Surface | null,
    method: string,
  ): { rendered: Rendered; served: Served; normalized: NormalizedRequest | null } {
    if (received.oversized) return errorOutcome(SERVER_ERRORS.requestTooLarge, 'invalid');
    if (surface === null) return errorOutcome(SERVER_ERRORS.notFound, 'unmatched');
    if (method !== 'POST') return errorOutcome(SERVER_ERRORS.methodNotAllowed, 'unmatched');
    const body = parseJsonObject(received.text);
    if (body === null) return errorOutcome(SERVER_ERRORS.invalidJson, 'invalid');
    const parsed = surface.parse(body);
    if (!parsed.ok) return errorOutcome(parsed.error, 'invalid');
    const { normalized } = parsed;
    const ctx: RenderContext = { normalized, ids: this.ids };

    const asides = this.scenario.aside ?? [];
    const matching = asides.map((aside, index) => ({ aside, index })).filter(({ aside }) => matchesWhen(aside.when, normalized));
    if (matching.length > 1) return { ...errorOutcome(SERVER_ERRORS.ambiguousMatch, 'ambiguous'), normalized };
    if (matching.length === 1) {
      const { aside, index } = matching[0]!;
      return { rendered: surface.render(aside, ctx), served: { kind: 'aside', index, aside: aside.name }, normalized };
    }

    const last = this.scenario.responses.length - 1;
    const index = Math.min(this.cursor, last);
    const kind = this.cursor <= last ? 'scripted' : 'repeated';
    this.cursor += 1;
    return { rendered: surface.render(this.scenario.responses[index]!, ctx), served: { kind, index, aside: null }, normalized };
  }
}

function errorOutcome(error: ErrorSpec, kind: Served['kind']): { rendered: Rendered; served: Served; normalized: null } {
  return {
    rendered: {
      status: error.status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'error', error: { type: error.type, message: error.message } }),
    },
    served: { kind, index: null, aside: null },
    normalized: null,
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Read the whole body, keeping at most MAX_BODY_BYTES; an oversized body is drained and reported, not buffered. */
function readBody(req: IncomingMessage): Promise<ReceivedBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.once('error', reject);
    req.once('end', () => {
      resolve(bytes > MAX_BODY_BYTES ? { oversized: true } : { oversized: false, text: Buffer.concat(chunks).toString('utf8') });
    });
  });
}
