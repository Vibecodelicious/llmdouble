import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { callsOf, loadScenario, ScenarioError, usageOf, validateScenario } from './scenario.js';

const valid = {
  responses: [
    { say: 'first', calls: [{ tool: 'read_file', with: { path: 'a.ts' } }], usage: { input: 10, output: 2 } },
    { say: '' },
  ],
  aside: [{ name: 'title', when: { system: { contains: 'title' } }, say: 'Untitled' }],
};

function rejection(value: unknown): string {
  try {
    validateScenario(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ScenarioError);
    return (error as Error).message;
  }
  throw new Error('expected validateScenario to throw');
}

describe('validateScenario', () => {
  test('accepts a valid scenario and preserves it', () => {
    expect(validateScenario(valid)).toEqual(valid);
  });

  test('defaults calls to [] and usage to zeros at the use site', () => {
    const scenario = validateScenario({ responses: [{ say: 'x' }] });
    expect(callsOf(scenario.responses[0]!)).toEqual([]);
    expect(usageOf(scenario.responses[0]!)).toEqual({ input: 0, output: 0 });
    expect(usageOf({ say: '', usage: { input: 3, output: 4 } })).toEqual({ input: 3, output: 4 });
  });

  test('a partial usage fills the missing side with zero', () => {
    const scenario = validateScenario({ responses: [{ say: 'x', usage: { input: 7 } }] });
    expect(scenario.responses[0]!.usage).toEqual({ input: 7, output: 0 });
  });

  test.each<[string, unknown, string]>([
    ['non-object root', [], 'scenario must be an object'],
    ['missing responses', {}, 'responses must be an array'],
    ['empty responses', { responses: [] }, 'responses must not be empty'],
    ['unknown root key', { responses: [{ say: '' }], asides: [] }, 'scenario.asides is not a recognised field'],
    ['response not object', { responses: ['hi'] }, 'responses[0] must be an object'],
    ['missing say', { responses: [{ calls: [] }] }, 'responses[0].say must be a string'],
    ['unknown response key', { responses: [{ say: '', sey: 'x' }] }, 'responses[0].sey is not a recognised field'],
    ['calls not array', { responses: [{ say: '', calls: {} }] }, 'responses[0].calls must be an array'],
    ['call missing tool', { responses: [{ say: '' }, { say: '', calls: [{ with: {} }] }] }, 'responses[1].calls[0].tool must be a non-empty string'],
    ['call with not object', { responses: [{ say: '', calls: [{ tool: 't', with: 'x' }] }] }, 'responses[0].calls[0].with must be an object'],
    ['usage negative', { responses: [{ say: '', usage: { input: -1 } }] }, 'responses[0].usage.input must be a non-negative integer'],
    ['usage fractional', { responses: [{ say: '', usage: { output: 1.5 } }] }, 'responses[0].usage.output must be a non-negative integer'],
    ['usage unknown key', { responses: [{ say: '', usage: { tokens: 1 } }] }, 'responses[0].usage.tokens is not a recognised field'],
    ['aside not array', { responses: [{ say: '' }], aside: {} }, 'aside must be an array'],
    ['aside missing name', { responses: [{ say: '' }], aside: [{ when: { model: { equals: 'x' } }, say: '' }] }, 'aside[0].name must be a non-empty string'],
    ['aside missing when', { responses: [{ say: '' }], aside: [{ name: 'a', say: '' }] }, 'aside[0].when must be an object'],
    ['aside empty when', { responses: [{ say: '' }], aside: [{ name: 'a', when: {}, say: '' }] }, 'aside[0].when must name at least one field'],
    ['aside duplicate name', { responses: [{ say: '' }], aside: [{ name: 'a', when: { model: { equals: 'x' } }, say: '' }, { name: 'a', when: { model: { equals: 'y' } }, say: '' }] }, 'aside[1].name duplicates aside name "a"'],
    ['when unknown field', { responses: [{ say: '' }], aside: [{ name: 'a', when: { path: { equals: '/' } }, say: '' }] }, 'aside[0].when.path is not a recognised field'],
    ['string matcher two operators', { responses: [{ say: '' }], aside: [{ name: 'a', when: { model: { equals: 'x', contains: 'y' } }, say: '' }] }, 'aside[0].when.model must contain exactly one of equals, contains, startsWith, endsWith'],
    ['string matcher wrong operand', { responses: [{ say: '' }], aside: [{ name: 'a', when: { system: { contains: 3 } }, say: '' }] }, 'aside[0].when.system.contains must be a string'],
    ['string matcher unknown operator', { responses: [{ say: '' }], aside: [{ name: 'a', when: { model: { matches: 'x' } }, say: '' }] }, 'aside[0].when.model.matches is not a recognised field'],
    ['tools bad absent', { responses: [{ say: '' }], aside: [{ name: 'a', when: { tools: { absent: 'yes' } }, say: '' }] }, 'aside[0].when.tools.absent must be a boolean'],
    ['tools bad includes', { responses: [{ say: '' }], aside: [{ name: 'a', when: { tools: { includes: '' } }, say: '' }] }, 'aside[0].when.tools.includes must be a non-empty string'],
    ['messages missing count', { responses: [{ say: '' }], aside: [{ name: 'a', when: { messages: {} }, say: '' }] }, 'aside[0].when.messages.count is required'],
    ['number matcher wrong operand', { responses: [{ say: '' }], aside: [{ name: 'a', when: { messages: { count: { lt: '3' } } }, say: '' }] }, 'aside[0].when.messages.count.lt must be a number'],
    ['number matcher unknown operator', { responses: [{ say: '' }], aside: [{ name: 'a', when: { maxTokens: { lte: 3 } }, say: '' }] }, 'aside[0].when.maxTokens.lte is not a recognised field'],
  ])('rejects %s naming the path', (_label, value, message) => {
    expect(rejection(value)).toContain(message);
  });
});

describe('loadScenario', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llmdouble-scenario-'));

  test('loads a valid file', () => {
    const path = join(dir, 'ok.json');
    writeFileSync(path, JSON.stringify(valid));
    expect(loadScenario(path)).toEqual(valid);
  });

  test('prefixes validation failures with the file path', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify({ responses: [{ say: '', calls: [{ tool: 1 }] }] }));
    expect(() => loadScenario(path)).toThrow(`${path}: responses[0].calls[0].tool must be a non-empty string`);
  });

  test('reports invalid JSON without a stack trace', () => {
    const path = join(dir, 'syntax.json');
    writeFileSync(path, '{ responses: [ }');
    expect(() => loadScenario(path)).toThrow(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: not valid JSON: `));
  });

  test('reports a missing file', () => {
    const path = join(dir, 'missing.json');
    expect(() => loadScenario(path)).toThrow(`${path}: cannot read scenario file`);
  });
});
