// Public API of llmdouble. Story 2 adds `load`, `Recording`, `BlockedError`,
// and the matchers; story 3 adds `run` and `differential`.

export { startServer, MAX_BODY_BYTES, SERVER_ERRORS } from './core/server.js';
export type { StartServerOptions, ServerHandle, Surface, ParseResult, RenderContext, Rendered, ErrorSpec } from './core/server.js';
export { loadScenario, validateScenario, ScenarioError } from './core/scenario.js';
export type {
  Scenario,
  ScriptedResponse,
  Aside,
  ToolCall,
  Usage,
  When,
  StringMatcher,
  NumberMatcher,
  ToolsMatcher,
} from './core/scenario.js';
export { matchesWhen } from './core/matcher.js';
export { messageText, systemText } from './core/normalize.js';
export type { NormalizedRequest, NormalizedMessage, NormalizedBlock } from './core/normalize.js';
export { readRecording, redactHeaders, REDACTED_HEADERS, RECORDING_FORMAT } from './core/recording.js';
export type {
  RecordingFile,
  RecordingLine,
  RunLine,
  RequestLine,
  SummaryLine,
  RunSummary,
  Served,
  ServedKind,
  SurfaceName,
} from './core/recording.js';
