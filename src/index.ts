// Public API of llmdouble. Story 3 adds `run` and `differential`.

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
export { load } from './assert/load.js';
export { matchers } from './assert/matchers.js';
export { BlockedError } from './assert/verdict.js';
export type { Verdict, VerdictStatus } from './assert/verdict.js';
export type { Recording, RecordingSummary } from './assert/recording.js';
export type { Request, ContentClaims } from './assert/request.js';
export type { Region } from './assert/region.js';
export type { Divergence, DivergentRequest, OnlyInSelector } from './assert/divergence.js';
export type { MatcherResult, MatcherContext } from './assert/matchers.js';
