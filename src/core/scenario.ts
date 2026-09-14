// Scenario loading and validation (epic C2).
//
// A scenario scripts the ordered responses the server serves, plus optional
// asides that answer out-of-band requests without advancing the cursor.
// Validation rejects with a message naming the offending path
// (`responses[2].calls[0].tool`), never a stack trace, and rejects unknown
// keys so a misspelled field cannot silently never match.

import { readFileSync } from 'node:fs';

export interface Usage {
  input: number;
  output: number;
}

export interface ToolCall {
  tool: string;
  with?: Record<string, unknown>;
}

export interface ScriptedResponse {
  say: string;
  calls?: ToolCall[];
  usage?: Usage;
}

export type StringMatcher =
  | { equals: string }
  | { contains: string }
  | { startsWith: string }
  | { endsWith: string };

export type NumberMatcher = { equals: number } | { lt: number } | { gt: number };

export type ToolsMatcher = { absent: boolean } | { includes: string };

/** All fields optional and ANDed. Exactly the wire-visible differences design §4.1 names. */
export interface When {
  model?: StringMatcher;
  system?: StringMatcher;
  tools?: ToolsMatcher;
  messages?: { count: NumberMatcher };
  maxTokens?: NumberMatcher;
}

export interface Aside extends ScriptedResponse {
  name: string;
  when: When;
}

export interface Scenario {
  responses: ScriptedResponse[];
  aside?: Aside[];
}

export class ScenarioError extends Error {
  override readonly name = 'ScenarioError';
}

const ZERO_USAGE: Usage = { input: 0, output: 0 };

/** The calls a response makes; `[]` when the scenario omitted `calls`. */
export function callsOf(response: ScriptedResponse): ToolCall[] {
  return response.calls ?? [];
}

/** The usage a response reports; zeros when the scenario omitted `usage`. */
export function usageOf(response: ScriptedResponse): Usage {
  return response.usage ?? ZERO_USAGE;
}

/** Read and validate a scenario file. Every failure is a `ScenarioError` prefixed with the file path. */
export function loadScenario(path: string): Scenario {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ScenarioError(`${path}: cannot read scenario file: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ScenarioError(`${path}: not valid JSON: ${(error as Error).message}`);
  }
  try {
    return validateScenario(value);
  } catch (error) {
    if (error instanceof ScenarioError) throw new ScenarioError(`${path}: ${error.message}`);
    throw error;
  }
}

/** Validate a parsed scenario value against C2. Throws `ScenarioError` naming the offending path. */
export function validateScenario(value: unknown): Scenario {
  const root = expectObject(value, 'scenario');
  rejectUnknownKeys(root, 'scenario', ['responses', 'aside']);

  if (!Array.isArray(root.responses)) fail('responses', 'must be an array');
  if (root.responses.length === 0) fail('responses', 'must not be empty');
  const responses = root.responses.map((entry, i) => validateResponse(entry, `responses[${i}]`));

  const scenario: Scenario = { responses };
  if (root.aside !== undefined) {
    if (!Array.isArray(root.aside)) fail('aside', 'must be an array');
    const names = new Set<string>();
    scenario.aside = root.aside.map((entry, i) => {
      const aside = validateAside(entry, `aside[${i}]`);
      if (names.has(aside.name)) fail(`aside[${i}].name`, `duplicates aside name "${aside.name}"`);
      names.add(aside.name);
      return aside;
    });
  }
  return scenario;
}

function validateResponse(value: unknown, path: string, extraKeys: string[] = []): ScriptedResponse {
  const obj = expectObject(value, path);
  rejectUnknownKeys(obj, path, ['say', 'calls', 'usage', ...extraKeys]);
  if (typeof obj.say !== 'string') fail(`${path}.say`, 'must be a string');
  const response: ScriptedResponse = { say: obj.say };
  if (obj.calls !== undefined) {
    if (!Array.isArray(obj.calls)) fail(`${path}.calls`, 'must be an array');
    response.calls = obj.calls.map((call, i) => validateCall(call, `${path}.calls[${i}]`));
  }
  if (obj.usage !== undefined) response.usage = validateUsage(obj.usage, `${path}.usage`);
  return response;
}

function validateCall(value: unknown, path: string): ToolCall {
  const obj = expectObject(value, path);
  rejectUnknownKeys(obj, path, ['tool', 'with']);
  if (typeof obj.tool !== 'string' || obj.tool.length === 0) fail(`${path}.tool`, 'must be a non-empty string');
  const call: ToolCall = { tool: obj.tool };
  if (obj.with !== undefined) call.with = expectObject(obj.with, `${path}.with`);
  return call;
}

function validateUsage(value: unknown, path: string): Usage {
  const obj = expectObject(value, path);
  rejectUnknownKeys(obj, path, ['input', 'output']);
  return {
    input: obj.input === undefined ? 0 : expectCount(obj.input, `${path}.input`),
    output: obj.output === undefined ? 0 : expectCount(obj.output, `${path}.output`),
  };
}

function validateAside(value: unknown, path: string): Aside {
  const response = validateResponse(value, path, ['name', 'when']);
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) fail(`${path}.name`, 'must be a non-empty string');
  return { ...response, name: obj.name, when: validateWhen(obj.when, `${path}.when`) };
}

function validateWhen(value: unknown, path: string): When {
  const obj = expectObject(value, path);
  rejectUnknownKeys(obj, path, ['model', 'system', 'tools', 'messages', 'maxTokens']);
  if (Object.keys(obj).length === 0) fail(path, 'must name at least one field (an empty when matches every request)');
  const when: When = {};
  if (obj.model !== undefined) when.model = validateStringMatcher(obj.model, `${path}.model`);
  if (obj.system !== undefined) when.system = validateStringMatcher(obj.system, `${path}.system`);
  if (obj.tools !== undefined) when.tools = validateToolsMatcher(obj.tools, `${path}.tools`);
  if (obj.messages !== undefined) {
    const messages = expectObject(obj.messages, `${path}.messages`);
    rejectUnknownKeys(messages, `${path}.messages`, ['count']);
    if (messages.count === undefined) fail(`${path}.messages.count`, 'is required');
    when.messages = { count: validateNumberMatcher(messages.count, `${path}.messages.count`) };
  }
  if (obj.maxTokens !== undefined) when.maxTokens = validateNumberMatcher(obj.maxTokens, `${path}.maxTokens`);
  return when;
}

const STRING_OPERATORS = ['equals', 'contains', 'startsWith', 'endsWith'] as const;
const NUMBER_OPERATORS = ['equals', 'lt', 'gt'] as const;

function validateStringMatcher(value: unknown, path: string): StringMatcher {
  const [operator, operand] = singleOperator(value, path, STRING_OPERATORS);
  if (typeof operand !== 'string') fail(`${path}.${operator}`, 'must be a string');
  return { [operator]: operand } as StringMatcher;
}

function validateNumberMatcher(value: unknown, path: string): NumberMatcher {
  const [operator, operand] = singleOperator(value, path, NUMBER_OPERATORS);
  if (typeof operand !== 'number' || !Number.isFinite(operand)) fail(`${path}.${operator}`, 'must be a number');
  return { [operator]: operand } as NumberMatcher;
}

function validateToolsMatcher(value: unknown, path: string): ToolsMatcher {
  const [operator, operand] = singleOperator(value, path, ['absent', 'includes'] as const);
  if (operator === 'absent') {
    if (typeof operand !== 'boolean') fail(`${path}.absent`, 'must be a boolean');
    return { absent: operand };
  }
  if (typeof operand !== 'string' || operand.length === 0) fail(`${path}.includes`, 'must be a non-empty string');
  return { includes: operand };
}

function singleOperator<T extends string>(value: unknown, path: string, allowed: readonly T[]): [T, unknown] {
  const obj = expectObject(value, path);
  rejectUnknownKeys(obj, path, allowed);
  const keys = Object.keys(obj);
  if (keys.length !== 1) fail(path, `must contain exactly one of ${allowed.join(', ')}`);
  const operator = keys[0] as T;
  return [operator, obj[operator]];
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'must be an object');
  return value as Record<string, unknown>;
}

function expectCount(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(path, 'must be a non-negative integer');
  return value as number;
}

function rejectUnknownKeys(obj: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, `is not a recognised field (expected one of ${allowed.join(', ')})`);
  }
}

function fail(path: string, expectation: string): never {
  throw new ScenarioError(`${path} ${expectation}`);
}
