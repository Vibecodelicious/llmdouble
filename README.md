# llmdouble

An HTTP server that impersonates an LLM provider. Point something at it — a coding agent, a script, an application — and it serves scripted responses while recording every request it receives as JSONL.

What the model sees *is* the request payload. Record the exact bytes a client sends and every question about model-visible context becomes a deterministic assertion over a file: no credentials, no token spend, no nondeterminism.

Two faces, one engine:

- **Development tool.** Run `llmdouble serve`, point your agent at it, and watch what it actually sends, request by request, with byte deltas.
- **Test infrastructure.** The same recording, read back by a test through the assertion library: content presence and absence, structure, scoped byte measurement of a region, cross-request claims, and a differential between two recordings. The recording format below is the contract between the two faces.

This slice is the Anthropic Messages surface, streaming only, plus the assertion library, `llmdouble diff`, and `run`/`differential`, which execute a system under test against a live server and hand back its recording. The OpenAI chat-completions surface follows.

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

If the server itself fails while serving (the recording file can no longer be written, for instance), it answers nothing from then on, `serve` exits 1 with the message, and the recording has no summary line: a run that did not close cleanly, never a run that looks complete.

## `llmdouble diff`

```
llmdouble diff <recording.jsonl> <N> <M>
```

Prints the JSON paths at which request `N`'s body differs from request `M`'s, one per line, both taken from the one recording (`N` and `M` are `seq` values). The comparison is over the parsed raw bodies, so ids and every wire field count. Exits 0 whether or not they differ (`request 2 and request 2 are identical` when they do not), and 2 with a message when an argument is bad, the recording cannot be read, or a request number is absent.

```
$ llmdouble diff recording.jsonl 1 3
$.messages[0].content
$.messages[1].content
$.messages[2].content
$.messages[3].content
$.messages[4].content
$ llmdouble diff recording.jsonl 1 9
request 9 is absent: recording recording.jsonl has 3 requests
```

A path names the deepest node at which the two sides differ: a leaf with different values, a key present on one side only, an array element past the shorter length, or a node whose kinds differ (a string on one side, an array on the other).

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
- The summary counts: `scripted` is how many responses the scenario scripts; `served` is how many requests the main sequence answered (`scripted` plus `repeated` kinds); the rest count requests by kind. A file with no `summary` line is a run that did not close cleanly and is still readable; `load` then computes every count from the request lines present, and `scripted` is the number of distinct scripted responses served (a lower bound, not the scenario's length). Check `summary.complete` before treating any count as the run's.

Reading it back: `jq -c 'select(.type=="request") | {seq, path, status, served}' llmdouble-*.jsonl`, or `load` below.

## Running a system under test

`run` starts a server on an ephemeral port, executes something against it, stops the server, and returns the recording:

```ts
import { run } from 'llmdouble';

const rec = await run('./examples/echo-client/scenario.json', {
  exec: 'node examples/echo-client/client.mjs',
  env: { ANTHROPIC_BASE_URL: '$URL', ANTHROPIC_API_KEY: 'x', ECHO_FEATURE: '1' },
});
rec.count;      // 2
rec.exitCode;   // 0
```

- `$URL` is the listen address (`http://127.0.0.1:<port>`) and is substituted in `exec`, `setup`, and every `env` value; `env` is laid over the current process's environment. A function `exec` receives `{ url }` instead and is awaited, for drivers that run several processes against one server.
- A string `exec` runs under `sh -c` in `cwd` (default: the current directory), in its own process group. `setup`, when given, runs first the same way; a non-zero exit from `setup` throws, because an off arm whose patch did not apply must not be compared as if it had. `setup`'s process group is swept when `setup` exits, like `exec`'s, so anything that must outlive `setup` (a helper service, a watcher) belongs in `exec` or a function `exec`.
- A non-zero exit from `exec` is data: `run` returns normally with `exitCode` set (`null` for a function `exec` or a process that ended by a signal). Its stdout and stderr go to two log files next to the recording, named by replacing the `.jsonl` suffix: `run.stdout.log` and `run.stderr.log` for `run.jsonl`. Like the recording, they are written fresh by each run; `setup` and then `exec` append to them in order.
- `timeoutMs` (default 120000) covers `setup` and `exec` together. At the deadline the process group is killed (SIGTERM, then SIGKILL a second later), the server is closed so the recording is complete, and `run` throws an error that names the recording path. Whatever a command left running in its group when it exited is killed too.
- A server that cannot start throws before anything is executed. A server that fails during the run (see `serve` above) aborts it at once: the command is killed and `run` throws with the cause and the recording path rather than waiting for the timeout.
- `record` is the recording path; the default is a file under the OS temp directory.

The example client under `examples/echo-client/` is a stand-in for a harness with a feature flag. It sends two requests; with `ECHO_FEATURE=1` it replaces a message marked `[archive-me]` with the placeholder `[archived]` before its second request. To watch it by hand:

```sh
npm run build
node dist/cli.js serve --scenario examples/echo-client/scenario.json
# in another shell, with the port the listening line printed:
ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ECHO_FEATURE=1 node examples/echo-client/client.mjs
```

`src/run/example.test.ts` runs the same client through `run` and `differential` and asserts over the recordings; `npx vitest run src/run/example.test.ts` runs it alone. It needs no network and no credentials, which is how it runs in CI.

## Asserting over a recording

The design this tool implements (`DESIGN-test-specification-language.md` §5.0) opens with this test. With the shipped names, against a recording in which the client archived the messages between "step one" and "step four" before its last request:

```ts
import { load, matchers } from 'llmdouble';

expect.extend(matchers);

const rec = load('./recordings/refactor.jsonl');

expect(rec.count).toBe(3);
expect(rec.last.doesNotContain(process.env.API_SECRET!)).toPass();
expect(rec.last.tools.registered).toContain('read_file');

const archived = rec.messagesBetween({ from: 'step one', to: 'step four' });
expect(rec.last.footprintOf(archived)).toBe(0);
expect(rec.request(1).footprintOf(archived)).toBeGreaterThan(0);
```

`src/assert/design-5-0.test.ts` is exactly this, against `src/assert/fixtures/prune.jsonl`, which the server recorded from such a client; the test's second half edits the fixture to leave the archived text in place and proves the assertions then fail.

### Verdicts

Content claims return a `Verdict`, a plain object: `{ status: 'PASS' | 'FAIL' | 'BLOCKED', claim, evidence }`. **BLOCKED** means the apparatus could not evaluate the claim, and it exists because an empty recording satisfies every absence claim: if capture broke or nothing was recorded, `doesNotContain` would hold trivially. Any assertion whose inputs are absent reports BLOCKED, never PASS: `every` over an empty recording, a search text that is empty or `undefined` (an unset `process.env.SECRET`), a `system` claim on a request the surface could not normalise.

Methods that return a literal rather than a verdict (`rec.last`, `rec.request(9)`, `rec.servedBy(2)`, `req.messages`, `req.footprintOf(region)`) throw `BlockedError` in the same situations; `error.verdict.claim` names the cause. Either way the test fails; neither way can it pass.

`matchers.toPass()` is the one runner integration, in the `expect.extend` protocol vitest, jest, and bun:test share: PASS passes, FAIL fails with the claim and evidence, BLOCKED fails with a message beginning `BLOCKED:`, and BLOCKED fails under `.not` too. Types for the matcher are the consumer's three lines, for vitest:

```ts
declare module 'vitest' {
  interface Assertion<T = unknown> { toPass(): T }
}
```

### The vocabulary

| | |
|---|---|
| `rec.count`, `rec.requests` | every recorded request, rejections included |
| `rec.first`, `rec.last`, `rec.request(n)` | by `seq` (1-based); `BlockedError` when absent |
| `rec.servedBy(i)` | the one request served by scripted response `i`; asides and repeats never match; `BlockedError` when none or more than one |
| `rec.summary` | the counts, plus `complete: false` when the file had no summary line (the run did not close cleanly); every count is then computed from the request lines present and `scripted` is the distinct scripted responses served, a lower bound, so check `complete` before treating any count as the run's |
| `req.contains(text)`, `req.doesNotContain(text)` | over `raw.body`, the exact bytes; a hit's `evidence.offset` is where |
| `req.system.contains(text)`, `.doesNotContain(text)` | over the normalised system text |
| `req.messages.count`, `.roles`, `.texts` | the normalised view; `texts` concatenates every block, tool inputs as JSON |
| `req.tools.registered` | tool names in wire order |
| `req.totalBytes` | UTF-8 length of `raw.body`; a literal with no verdict attached |
| `rec.messagesMatching(text)` | a region: every message whose text contains the literal |
| `rec.messagesBetween({ from, to })` | a region: the span from the first message containing `from` through the first later message containing `to` |
| `req.footprintOf(region)` | UTF-8 bytes of the wire messages the region selects in this request |
| `rec.every.contains(text)`, `.doesNotContain(text)` | across every request's `raw.body`; FAIL lists `evidence.failingSeqs`; BLOCKED when empty |
| `rec.diff(other)` | a `Divergence`: per request, the JSON paths at which the parsed bodies differ |
| `divergence.onlyIn(selector)` | PASS only when at least one difference exists and every difference is inside the selector |

### Regions and measurement

A region is a content predicate re-evaluated against each request, never a resolved set of message indices. Content that moved to a different position still matches; a request where the predicate matches nothing measures 0. The predicate runs over the normalised message texts; the bytes come from the wire: `footprintOf` sums the UTF-8 length of `JSON.stringify` of the raw body's `messages[i]` at each selected index. A region that matches nothing in any request of the recording is unanchored, and measuring it throws `BlockedError`, because a row of satisfied zeroes is indistinguishable from removed content. A region belongs to the recording that created it, and measuring it against another recording's request throws `BlockedError` too, since the anchoring check would otherwise never have run over the recording being measured; build one region per recording (`on.messagesMatching(secret)` for `on`, `off.messagesMatching(secret)` for `off`).

Measurement is per request and the comparison is yours: `expect(rec.last.footprintOf(region)).toBeLessThan(rec.request(1).footprintOf(region))`. Nothing packages a cross-request comparison as a verdict, because a region can legitimately shrink, grow, or move for reasons unrelated to the feature under test, and whole-payload deltas are not a sound claim at all: a system that injects and removes in the same request can grow the payload while pruning correctly. `totalBytes` is readable with the same restraint.

### Diffing two recordings

`rec.diff(other)` pairs requests strictly by array position and reports the differing leaf paths per request (`["$"]` for a request only one side has). "Differs somewhere" is nearly always true, so the verdict is `onlyIn`:

```ts
const d = on.diff(off);
expect(d.onlyIn({ messages: [2, 3] })).toPass();      // 1-based, inclusive: $.messages[1] and $.messages[2]
expect(d.onlyIn({ paths: ['$.messages', '$.system'] })).toPass();
```

PASS requires at least one difference and every difference under the selector; identical recordings FAIL with claim `recordings identical`; anything outside is listed in `evidence.outside`. A prefix covers what is nested under it and stops at a path boundary (`$.messages[1]` does not cover `$.messages[10]`). Requests that exist on one side only diverge at `$`, outside every selector, so assert equal counts before relying on the pairing.

`differential` below produces the two recordings; `load` and `close()` do too.

## Differential

A suite whose absence claims always pass proves nothing: broken capture, an empty body, or a wrong path pass forever. `differential` runs the same scenario twice, once with the feature on and once with it off, on separate servers with separate recordings, so the test can require the opposite result from the off arm (design §5.7). From `src/run/example.test.ts`:

```ts
import { differential, matchers } from 'llmdouble';

expect.extend(matchers);

const { on, off } = await differential('./examples/echo-client/scenario.json', {
  exec: 'node examples/echo-client/client.mjs',
  env: { ANTHROPIC_BASE_URL: '$URL', ANTHROPIC_API_KEY: 'x' },
  on: { env: { ECHO_FEATURE: '1' } },
  off: { env: { ECHO_FEATURE: '0' } },
});

expect(on.diff(off).onlyIn({ messages: [2, 2] })).toPass();   // the feature changed message 2 of request 2 and nothing else
expect(off.last.contains('[archive-me]')).toPass();            // present when the feature is off
expect(on.last.doesNotContain('[archive-me]')).toPass();       // absent when it is on
```

Each arm is `{ exec?, env?, setup?, scenario? }`. Per-arm `env` merges over the shared `env`; per-arm `exec`, `setup`, and `scenario` replace the shared ones; `cwd` and `timeoutMs` are shared. An arm accepts a `setup` command as readily as an environment variable, for a system whose off arm is a different artifact (`on: { setup: 'npm run apply:patch' }`, `off: { setup: 'npm run apply:restore' }`), and its own `scenario`, for an off arm where the scripted tool is not registered. The arms run sequentially, on first. Both results are `run` results, so the whole vocabulary above applies to each; build regions per arm (`on.messagesMatching(...)` for `on`, `off.messagesMatching(...)` for `off`).

The example test's second half is the negative control: it copies the client with the flag check replaced by `false`, runs the same differential, and asserts that `onlyIn` FAILs with `recordings identical`. That is the proof the apparatus can fail, and it is the test to copy when pointing the differential at something real.

## Programmatic use

```ts
import { startServer } from 'llmdouble';

const server = await startServer({ scenario: './scenario.json' });   // or an inline scenario object
// server.url        -> 'http://127.0.0.1:<port>'
// server.recordPath -> the JSONL path (opts.record, or a file under the OS temp dir)
// ... point a client at server.url ...
const rec = await server.close();                                     // writes the summary line, returns the Recording loaded from the file
expect(rec.last.doesNotContain(secret)).toPass();
```

`startServer` options: `scenario` (path or object), `port` (default 0), `host` (only `'127.0.0.1'` is accepted), `record` (JSONL path), `onRequest(line)`, called with each request line as it is recorded, and `onError(error)`, called once if serving fails (the recording cannot be appended, a surface's render throws, `onRequest` throws); after that the server answers nothing and `close()` throws the same error without writing a summary line. `close()` otherwise returns what `load(server.recordPath)` returns. `readRecording(path)` is the lower-level parse into raw lines. `run` and `differential` are built on it. The scenario, request-line, normalised-request, run (`RunOptions`, `RunResult`, `Arm`, `DifferentialOptions`), and assertion types (`Recording`, `Request`, `Region`, `Verdict`, `Divergence`) are exported from the package root.

## What this cannot tell you

It proves what a client sent, not how a real provider interprets it. Scripted replies are not model behaviour: it shows that *if* the model called the tool, the client handled the result correctly, never that the model would. See `STANDARDS.md` for conventions and the module layout.
