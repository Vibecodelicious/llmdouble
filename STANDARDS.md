# Coding Standards — llmdouble

## Authority

- This repo is a provider-shaped test double: an HTTP server that impersonates an LLM provider, serves scripted responses, and records every request as JSONL. It is not a port of any host and mirrors no agent repo; the conventions below are chosen for the language and written down here.
- The server does not know what a harness is. Nothing harness-specific (per-agent configuration, wiring recipes, `if harness == ...`) lands in this repo. Callers that send out-of-band traffic are handled by ordinary request matching in the scenario file.
- Core ships measurement primitives; verdicts belong to consumers built on top.

## Language / runtime

- TypeScript, `strict: true`, targeting Node >= 22 (`engines.node` in `package.json`).
- ESM only: `"type": "module"`, `module` and `moduleResolution` are `NodeNext`, relative imports carry the `.js` extension.
- Node built-ins are imported via the `node:*` prefix. Nothing else is imported at runtime: the package has zero runtime dependencies, and that is a claim consumers rely on, not a preference.
- `tsc` compiles `src/` to `dist/` with declarations and source maps (`tsconfig.json`: ES2022, NodeNext, strict, declaration, `outDir: dist`, `rootDir: src`). `dist/index.js` is the package entry and `dist/cli.js` is the `llmdouble` bin.

## Dependencies

- Runtime dependencies: none. A change that adds one needs a justification in the commit body and an update to this document.
- Dev dependencies: `typescript`, `vitest`, and `@types/node` only.
- `package-lock.json` is committed; CI installs with `npm ci`. Version ranges in `package.json` are kept in step with what the lock resolves.

## Linting / formatting

- `tsc --noEmit` is the discipline gate (`npm run typecheck`); it covers tests as well as sources because `tsconfig.json` includes all of `src/`. The build therefore also emits `*.test.js` into `dist/`; that is the accepted cost of typechecking tests with one config.
- No linter or formatter is configured. Two-space indentation, single quotes, semicolons, trailing commas on multi-line literals, 120-column lines.
- Exported functions and types carry a one-line doc comment saying what they are for. Module headers explain the module's role in a few lines.

## Testing

- `vitest` (`npm test` runs `vitest run`); tests are colocated `*.test.ts` files under `src/`, selected by `vitest.config.ts`.
- Server behaviour is tested over a real `127.0.0.1` socket with `node:http` requests, reading the SSE body and asserting exact event order. Nothing mocks the network.
- Scenario validation, `when` matching, normalisation, recording, and SSE rendering have unit tests with table cases over every field, operator, and error row.
- `src/assert/boundary.test.ts` scans every file under `src/assert/` and fails if an import resolves into `src/core/server`, `src/surfaces`, or `src/run`.
- The assertion library's unit tests build recordings in memory with `src/assert/testing.ts`, whose raw body and normalised view are hand-written on purpose (the reader must not depend on the surface). Writer and reader are proven to agree in `src/fixtures/prune.test.ts`, which records the prune conversation with the real server and compares it to the checked-in fixture.
- Fixtures under `src/assert/fixtures/*.jsonl` are recordings the real server wrote, checked in. Regenerate with `npm run fixtures` (builds, then runs `src/fixtures/prune.ts`) after any change to the recording format, the surface, or the fixture's conversation; `src/fixtures/prune.test.ts` fails until the checked-in file matches a fresh recording with `startedAt`, `url`, and `at` masked. Do not hand-edit a fixture: `src/assert/design-5-0.test.ts` shows how a test edits a copy to prove it can fail.
- `toPass()` types for this repo's own suites come from `src/assert/matchers.vitest.d.ts`, a `.d.ts` that tsc checks but does not emit, so the package's emitted declarations never refer to vitest.
- `src/run/example.test.ts` is the end-to-end proof: it runs `examples/echo-client/client.mjs` through `run` and `differential` and asserts the design's §5.0 and §5.7 claims over the recordings, then edits a copy of the client to prove the differential can fail. It runs in CI with no network and no credentials; nothing harness-shaped is needed.
- Tests of `run` drive `node -e` one-liners and shell snippets as the system under test. Every such test is bounded (an explicit `timeoutMs`, a process the command exits on its own) and leaves no process behind: a test that starts something long-lived proves it dead afterwards.
- The Claude Code wiring demo is manual evidence recorded in story notes, not a CI test: CI runs with no credentials and no harness.

## File / directory conventions

- `src/index.ts` — the public API. Consumers import from here (or from `dist/index.js`), never from internal paths.
- `src/cli.ts` — the `llmdouble` command: `serve` and `diff`.
- `src/core/` — the engine, surface-neutral:
  - `scenario.ts` — scenario loading and validation; errors name the offending path (`responses[2].calls[0].tool`).
  - `matcher.ts` — `when:` evaluation for asides.
  - `normalize.ts` — the `NormalizedRequest` shape and its text views.
  - `recording.ts` — the JSONL writer and reader, header redaction, run counts.
  - `ids.ts` — monotonic id counters.
  - `sse.ts` — server-sent events formatting and parsing.
  - `server.ts` — `startServer`, routing, the body limit, asides, the cursor, the error matrix, recording, and the failure rule: a failure while serving destroys the client's socket, reaches `onError` once, refuses every later request, and makes `close()` throw instead of writing a summary line.
- `src/surfaces/` — one module per provider wire format, each exporting a `Surface` (`parse` + `render`). The server owns everything that is not wire-format specific.
- `src/assert/` — the assertion library. Reads recordings; imports nothing from `core/server`, `surfaces`, or `run`:
  - `verdict.ts` — `Verdict`, `BlockedError`, and the empty-search-text rule.
  - `load.ts` — `load(path)`.
  - `recording.ts` — `Recording`: navigation, `servedBy`, `every`, regions, `diff`; the counts for a summary-less file.
  - `request.ts` — `Request`: raw-body and system claims, `messages`, `tools`, `totalBytes`, `footprintOf`.
  - `region.ts` — `Region` as a per-request predicate with the anchoring check; `messagesMatching` and `messagesBetween` predicates.
  - `divergence.ts` — the JSON leaf diff, `Divergence`, `onlyIn`.
  - `matchers.ts` — `toPass()` in the shared `expect.extend` shape.
  - `testing.ts` — in-memory recordings for the tests here; not exported from the package.
  - `fixtures/` — server-written recordings, checked in (see Testing).
- `src/fixtures/` — the fixture generators and the writer/reader agreement test; they drive the server, which is why they are not under `src/assert/`.
- `src/run/` — process orchestration around the server; imports core and assert:
  - `run.ts` — `run`: `$URL` substitution, `sh -c` in a detached process group, setup then exec, one deadline for both, the group killed on timeout (SIGTERM, then SIGKILL) and swept after exit, stdout and stderr appended to files next to the recording, a server failure aborting the run at once.
  - `differential.ts` — `differential`: the arm merge (`env` merged, `exec`/`setup`/`scenario` replaced, `cwd`/`timeoutMs` shared) and two sequential `run`s.
  - `example.test.ts` — the design §5.0 and §5.7 test against the example client, and its negative control.
- `examples/scenarios/` — scenario files the README refers to.
- `examples/echo-client/` — `client.mjs` and `scenario.json`: a dependency-free stand-in for a harness with a feature flag, documented by the README's "Running a system under test" section. Nothing in it is specific to any real harness.

## Import boundary

`src/assert/**` may import from `src/core/normalize`, `src/core/recording`, `src/core/scenario`, and `node:*`, and nothing from `src/core/server`, `src/surfaces`, or `src/run`. The assertion library must be usable against a recording file with no server in the process. The boundary test enforces this by scanning import specifiers; keep it passing rather than exempting a file.

## Process lifecycle

A string `exec` is spawned as `sh -c` with `detached: true`, so the command and everything it starts share a process group that `run` can signal as a unit (`process.kill(-pid, ...)`). Stdio goes to file descriptors, not pipes, so a grandchild holding a pipe open cannot stall the parent's exit. A run never leaves a process behind: the group is killed at the deadline and swept when the command exits.

## Adding a surface

A surface is a `Surface` object registered in `src/core/server.ts`: a `name` (the `surface` value recorded on every request line), a `path`, `parse(body)` producing a `NormalizedRequest` or an error spec, and `render(response, ctx)` producing status, headers, and body. Ids come from `ctx.ids.next(prefix)` with a surface-native prefix. The server handles routing, method checks, the 8 MiB limit, JSON parsing, asides, the cursor, and recording; a surface never records or touches the cursor.

## Out of scope

- Passthrough and replay modes, drift detection, cache analysis, judges, snapshots, fuzzing, any web UI.
- Token counting. Sizes are UTF-8 byte counts everywhere.
- Publishing to npm. Workspace consumers import the built sibling checkout by relative path.
