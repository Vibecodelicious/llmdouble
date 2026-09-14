# llmdouble

An HTTP server that impersonates an LLM provider. Point something at it — a coding agent, a script, an application — and it serves scripted responses while recording every request it receives as JSONL.

What the model sees *is* the request payload. Record the exact bytes a client sends and every question about model-visible context becomes a deterministic assertion over a file: no credentials, no token spend, no nondeterminism.

Two faces, one engine:

- **Development tool.** Run `llmdouble serve`, point your agent at it, and watch what it actually sends, request by request, with byte deltas.
- **Test infrastructure.** The same recording, read back by a test. The assertion library arrives in a later story; the recording format below is the contract between the two faces.

This is the first slice: the Anthropic Messages surface, streaming only. The OpenAI chat-completions surface, the assertion library, and the `run`/`differential` orchestration follow.

## Install

Node 22 or newer. No runtime dependencies.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`dist/cli.js` is the `llmdouble` command; `dist/index.js` is the programmatic API. Nothing is published to npm yet; consumers import the built checkout by relative path.

## Point a client at it

Every client reaches the server the way it already reaches a provider: a base URL and a placeholder key, set through the client's own configuration or environment. The server binds `127.0.0.1` only, checks no credentials, and serves `POST /v1/messages`.

For an Anthropic-speaking client the move is generically:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ANTHROPIC_API_KEY=x <your client>
```

The key value is irrelevant; it is recorded as `[redacted]`. Nothing client-specific ships here: which variable or config field a given client reads is that client's documentation.

## `llmdouble serve`

```
llmdouble serve --scenario <file.json> [--port N] [--record <path.jsonl>] [--raw]
```

- `--scenario` (required): the scenario file, see below.
- `--port`: port on `127.0.0.1`; default `0`, an ephemeral port printed on the listening line.
- `--record`: where the JSONL recording goes; default `./llmdouble-<timestamp>.jsonl` in the current directory. An existing file at that path is truncated.
- `--raw`: also print each request body.
- `-h`, `--help`.

The server prints one block per request and a summary when stopped with Ctrl-C:

```
listening on http://127.0.0.1:43493
recording to ./llmdouble-2026-09-14T05-10-16-321Z.jsonl
────────────────────────────────────────────────────────────
req 1  HEAD /api/hello  404  unmatched  22:10:16
  messages -   tools -   total 0 B
────────────────────────────────────────────────────────────
req 2  POST /v1/messages  200  scripted[0]  22:10:16
  messages 1   tools 0   total 915 B   (+915)
────────────────────────────────────────────────────────────
3 scripted, 1 served, 0 repeated, 0 asides, 1 unmatched, 0 ambiguous, 0 invalid
recording: ./llmdouble-2026-09-14T05-10-16-321Z.jsonl
```

Each block shows the sequence number, method and path, HTTP status, what was served (`scripted[i]`, `repeated[i]`, `aside[i] <name>`, or a rejection kind), the message and tool counts from the normalised request, the request body's UTF-8 size, and the delta from the previous request. Sizes are bytes, not tokens; no tokenizer is involved.

`llmdouble diff` is listed in the usage but exits 2 until the assertion library lands.

## Scenarios

A scenario is a JSON file with ordered responses and optional asides. `examples/scenarios/hello.json`:

```json
{
  "responses": [
    { "say": "Hello from llmdouble.", "usage": { "input": 12, "output": 5 } },
    {
      "say": "I'll read that file first.",
      "calls": [{ "tool": "read_file", "with": { "path": "src/parser.ts" } }],
      "usage": { "input": 4200, "output": 180 }
    },
    { "say": "Done." }
  ],
  "aside": [
    {
      "name": "title",
      "when": { "system": { "contains": "Generate a short, descriptive title" } },
      "say": "Untitled",
      "usage": { "input": 0, "output": 0 }
    }
  ]
}
```

Rules:

- `responses` is required and non-empty. Each response has a required `say` (may be `""`), optional `calls` (each `{ "tool": "<name>", "with": { ... } }`; `with` defaults to `{}`), and optional `usage` (`{ "input": n, "output": n }`, each side defaulting to 0). These are the input and output token counts the provider *reports*; they are scripted because clients drive budget behaviour from them.
- The cursor advances once per main-sequence request. After the last response, **the last response repeats**, and each such request is recorded as `repeated`. A run that takes an unexpected extra turn terminates instead of erroring.
- The stop reason is derived: `calls` present gives `tool_use`, otherwise `end_turn`. Ids are deterministic and monotonic across the run: `msg_1`, `msg_2`, ... and `toolu_1`, `toolu_2`, ....
- `aside` entries answer out-of-band requests (background title generation, summarisation) without advancing the cursor. Every request is checked against every aside first. Exactly one match is served and recorded as `aside` with the aside's `name`; more than one match is an HTTP 500 `ambiguous_match`, recorded as `ambiguous`; no match falls through to the main sequence. Each aside needs a unique `name`, a non-empty `when`, and the same `say`/`calls`/`usage` as a response.
- `when` fields are all optional and ANDed. They are exactly the wire-visible differences that separate auxiliary traffic from the main conversation:
  - `model`, `system`: a string matcher, one of `{ "equals" }`, `{ "contains" }`, `{ "startsWith" }`, `{ "endsWith" }`. `system` matches over the normalised system text (all system blocks, newline-joined).
  - `tools`: `{ "absent": true|false }` or `{ "includes": "<tool name>" }`.
  - `messages`: `{ "count": <number matcher> }`.
  - `maxTokens`: a number matcher, one of `{ "equals" }`, `{ "lt" }`, `{ "gt" }`. A request without `max_tokens` never matches a `maxTokens` matcher.
- Unknown keys anywhere are rejected, so a misspelled field cannot silently never match. Validation failures name the offending path, for example `responses[2].calls[0].tool must be a non-empty string`, and `serve` exits 1 with that message.

You find aside signatures by running your system against `serve` and reading whatever arrives that you did not script. A mis-matched aside consumes a scripted response and shifts every later turn by one; the summary's `served` and `repeated` counts make that visible.

## The Anthropic surface

`POST /v1/messages` with `"stream": true` returns `text/event-stream` in the order the Messages API streams: `message_start` (carrying the scripted `input` usage), then per content block `content_block_start`, `content_block_delta` (`text_delta` for `say`, `input_json_delta` for each call's `with`), `content_block_stop`; then `message_delta` with the stop reason and the scripted `output` usage; then `message_stop`. There is no `[DONE]` sentinel. The `model` in `message_start` echoes the request's model.

Everything else is a recorded JSON error of the form `{"type":"error","error":{"type":"...","message":"..."}}`:

| Request | Status | `error.type` | Recorded as |
|---|---|---|---|
| `stream` missing or not `true` | 422 | `stream_required` | `invalid` |
| body is not a JSON object | 400 | `invalid_json` | `invalid` |
| missing `model`/`messages`, malformed message, `system`/`tools` of the wrong type | 400 | `invalid_request` | `invalid` |
| body over 8 MiB | 413 | `request_too_large` | `invalid` |
| any path other than `/v1/messages` | 404 | `not_found` | `unmatched` |
| any method other than `POST` on `/v1/messages` | 405 | `method_not_allowed` | `unmatched` |
| more than one aside matches | 500 | `ambiguous_match` | `ambiguous` |

Never a silent 200: a client probing an unexpected route shows up in the recording.

## The recording

A JSONL file: one `run` line, one `request` line per request in receipt order, one `summary` line on close.

```jsonl
{"type":"run","format":1,"startedAt":"<iso>","url":"http://127.0.0.1:<port>","scenario":"<path or null>"}
{"type":"request","seq":1,"at":"<iso>","method":"POST","path":"/v1/messages","surface":"anthropic","status":200,
 "served":{"kind":"scripted","index":0,"aside":null},
 "headers":{"content-type":"application/json","x-api-key":"[redacted]"},
 "body":"<exact request body string>",
 "normalized":{"model":"claude-sonnet-4-6","stream":true,"maxTokens":1024,
   "system":[{"text":"..."}],
   "messages":[{"role":"user","content":[{"type":"text","text":"..."}]},
               {"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"read_file","input":{"path":"src/parser.ts"}}]},
               {"role":"user","content":[{"type":"tool_result","toolUseId":"toolu_1","text":"..."}]}],
   "tools":[{"name":"read_file"}]},
 "responseBody":"<exact response body string, SSE text when streamed>"}
{"type":"summary","scripted":3,"served":4,"repeated":1,"asides":1,"unmatched":0,"ambiguous":0,"invalid":0}
```

- `seq` is assigned in strict receipt order to every request that reaches the server, rejections included; there are no gaps.
- `surface` is `"anthropic"` or `null` for a route no surface owns. `served.kind` is one of `scripted | aside | repeated | unmatched | ambiguous | invalid`. `served.index` is the 0-based position in `responses[]` (the last index, repeatedly, once the sequence is exhausted), the position in `aside[]` for an aside, and `null` otherwise. `served.aside` is the aside's name or `null`.
- `headers` keys are lowercased; the values of `authorization`, `x-api-key`, `cookie`, and `proxy-authorization` are `[redacted]`. `body` is the exact bytes as a string and is never redacted: it is the evidence. A 413 row carries an empty `body`; the oversized bytes are not retained.
- `normalized` is `null` when the surface could not parse the body. Otherwise `messages` mirrors the wire `messages` array one-to-one and in order, with roles as sent. Content is reduced to three block kinds — `text`, `tool_use` (input kept as JSON), `tool_result` (`toolUseId` and the result text) — and everything else (images, thinking) becomes a `text` block holding the block's JSON. `system` is the top-level system blocks as `{ "text" }` entries. `cache_control` and every other field stay in the raw `body`.
- `responseBody` is the exact response text: the SSE stream for a served response, the JSON error otherwise.
- The summary counts: `scripted` is how many responses the scenario scripts; `served` is how many requests the main sequence answered (`scripted` plus `repeated` kinds); the rest count requests by kind. A file with no `summary` line is a run that did not close cleanly and is still readable.

Reading it back: `jq -c 'select(.type=="request") | {seq, path, status, served}' llmdouble-*.jsonl`.

## Programmatic use

```ts
import { startServer } from 'llmdouble';

const server = await startServer({ scenario: './scenario.json' });   // or an inline scenario object
// server.url        -> 'http://127.0.0.1:<port>'
// server.recordPath -> the JSONL path (opts.record, or a file under the OS temp dir)
// ... point a client at server.url ...
const summary = await server.close();                                 // writes the summary line, returns the counts
```

`startServer` options: `scenario` (path or object), `port` (default 0), `host` (only `'127.0.0.1'` is accepted), `record` (JSONL path), and `onRequest(line)`, called with each request line as it is recorded. `readRecording(path)` parses a recording file. The scenario, request-line, and normalised-request types are exported from the package root.

## What this cannot tell you

It proves what a client sent, not how a real provider interprets it. Scripted replies are not model behaviour: it shows that *if* the model called the tool, the client handled the result correctly, never that the model would. See `STANDARDS.md` for conventions and the module layout.
