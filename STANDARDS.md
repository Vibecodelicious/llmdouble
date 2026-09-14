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
- `package-lock.json` is committed; CI installs with `npm ci`.

## Linting / formatting

- `tsc --noEmit` is the discipline gate (`npm run typecheck`); it covers tests as well as sources because `tsconfig.json` includes all of `src/`. The build therefore also emits `*.test.js` into `dist/`; that is the accepted cost of typechecking tests with one config.
- No linter or formatter is configured. Two-space indentation, single quotes, semicolons, trailing commas on multi-line literals, 120-column lines.
- Exported functions and types carry a one-line doc comment saying what they are for. Module headers explain the module's role in a few lines.

## Testing

- `vitest` (`npm test` runs `vitest run`); tests are colocated `*.test.ts` files under `src/`, selected by `vitest.config.ts`.
- Server behaviour is tested over a real `127.0.0.1` socket with `node:http` requests, reading the SSE body and asserting exact event order. Nothing mocks the network.
- Scenario validation, `when` matching, normalisation, recording, and SSE rendering have unit tests with table cases over every field, operator, and error row.
- `src/assert/boundary.test.ts` scans every file under `src/assert/` and fails if an import resolves into `src/core/server`, `src/surfaces`, or `src/run`.
- The Claude Code wiring demo is manual evidence recorded in story notes, not a CI test: CI runs with no credentials and no harness.

## File / directory conventions

- `src/index.ts` — the public API. Consumers import from here (or from `dist/index.js`), never from internal paths.
- `src/cli.ts` — the `llmdouble` command (`serve`; `diff` arrives with the assertion library).
- `src/core/` — the engine, surface-neutral:
  - `scenario.ts` — scenario loading and validation; errors name the offending path (`responses[2].calls[0].tool`).
  - `matcher.ts` — `when:` evaluation for asides.
  - `normalize.ts` — the `NormalizedRequest` shape and its text views.
  - `recording.ts` — the JSONL writer and reader, header redaction, run counts.
  - `ids.ts` — monotonic id counters.
  - `sse.ts` — server-sent events formatting and parsing.
  - `server.ts` — `startServer`, routing, the body limit, asides, the cursor, the error matrix, recording.
- `src/surfaces/` — one module per provider wire format, each exporting a `Surface` (`parse` + `render`). The server owns everything that is not wire-format specific.
- `src/assert/` — the assertion library (story 2). Reads recordings; imports nothing from `core/server`, `surfaces`, or `run`.
- `src/run/` — `run` and `differential` (story 3).
- `examples/scenarios/` — scenario files the README refers to.

## Import boundary

`src/assert/**` may import from `src/core/normalize`, `src/core/recording`, `src/core/scenario`, and `node:*`, and nothing from `src/core/server`, `src/surfaces`, or `src/run`. The assertion library must be usable against a recording file with no server in the process. The boundary test enforces this by scanning import specifiers; keep it passing rather than exempting a file.

## Adding a surface

A surface is a `Surface` object registered in `src/core/server.ts`: a `name` (the `surface` value recorded on every request line), a `path`, `parse(body)` producing a `NormalizedRequest` or an error spec, and `render(response, ctx)` producing status, headers, and body. Ids come from `ctx.ids.next(prefix)` with a surface-native prefix. The server handles routing, method checks, the 8 MiB limit, JSON parsing, asides, the cursor, and recording; a surface never records or touches the cursor.

## Out of scope

- Passthrough and replay modes, drift detection, cache analysis, judges, snapshots, fuzzing, any web UI.
- Token counting. Sizes are UTF-8 byte counts everywhere.
- Publishing to npm. Workspace consumers import the built sibling checkout by relative path.
