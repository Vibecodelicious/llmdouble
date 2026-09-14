import { describe, expect, test } from 'vitest';
import { matchesWhen } from './matcher.js';
import type { NormalizedRequest } from './normalize.js';
import type { When } from './scenario.js';

const request: NormalizedRequest = {
  model: 'claude-3-5-haiku-latest',
  stream: true,
  maxTokens: 512,
  system: [{ text: 'You are helpful.' }, { text: 'Generate a short, descriptive title.' }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    { role: 'user', content: [{ type: 'text', text: 'title please' }] },
  ],
  tools: [{ name: 'read_file' }, { name: 'mcp__context-bonsai__context-bonsai-prune' }],
};

describe('matchesWhen', () => {
  test.each<[string, When, boolean]>([
    ['model equals (hit)', { model: { equals: 'claude-3-5-haiku-latest' } }, true],
    ['model equals (miss)', { model: { equals: 'claude-3-5-haiku' } }, false],
    ['model contains (hit)', { model: { contains: 'haiku' } }, true],
    ['model contains (miss)', { model: { contains: 'sonnet' } }, false],
    ['model startsWith (hit)', { model: { startsWith: 'claude-' } }, true],
    ['model startsWith (miss)', { model: { startsWith: 'gpt-' } }, false],
    ['model endsWith (hit)', { model: { endsWith: '-latest' } }, true],
    ['model endsWith (miss)', { model: { endsWith: '-haiku' } }, false],
    ['system equals over the joined text (hit)', { system: { equals: 'You are helpful.\nGenerate a short, descriptive title.' } }, true],
    ['system equals (miss)', { system: { equals: 'You are helpful.' } }, false],
    ['system contains across a later block (hit)', { system: { contains: 'descriptive title' } }, true],
    ['system contains (miss)', { system: { contains: 'summarise' } }, false],
    ['system startsWith (hit)', { system: { startsWith: 'You are' } }, true],
    ['system startsWith (miss)', { system: { startsWith: 'Generate' } }, false],
    ['system endsWith (hit)', { system: { endsWith: 'title.' } }, true],
    ['system endsWith (miss)', { system: { endsWith: 'helpful.' } }, false],
    ['tools absent true (miss: tools present)', { tools: { absent: true } }, false],
    ['tools absent false (hit)', { tools: { absent: false } }, true],
    ['tools includes (hit)', { tools: { includes: 'read_file' } }, true],
    ['tools includes (miss)', { tools: { includes: 'write_file' } }, false],
    ['messages count equals (hit)', { messages: { count: { equals: 3 } } }, true],
    ['messages count equals (miss)', { messages: { count: { equals: 2 } } }, false],
    ['messages count lt (hit)', { messages: { count: { lt: 4 } } }, true],
    ['messages count lt (miss, not inclusive)', { messages: { count: { lt: 3 } } }, false],
    ['messages count gt (hit)', { messages: { count: { gt: 2 } } }, true],
    ['messages count gt (miss, not inclusive)', { messages: { count: { gt: 3 } } }, false],
    ['maxTokens equals (hit)', { maxTokens: { equals: 512 } }, true],
    ['maxTokens equals (miss)', { maxTokens: { equals: 1024 } }, false],
    ['maxTokens lt (hit)', { maxTokens: { lt: 1000 } }, true],
    ['maxTokens lt (miss)', { maxTokens: { lt: 512 } }, false],
    ['maxTokens gt (hit)', { maxTokens: { gt: 100 } }, true],
    ['maxTokens gt (miss)', { maxTokens: { gt: 512 } }, false],
    ['AND: all fields hold', { model: { endsWith: '-latest' }, tools: { absent: false }, messages: { count: { gt: 1 } } }, true],
    ['AND: one field fails', { model: { endsWith: '-latest' }, tools: { absent: true } }, false],
  ])('%s', (_label, when, expected) => {
    expect(matchesWhen(when, request)).toBe(expected);
  });

  test('tools absent matches a request with no tools', () => {
    expect(matchesWhen({ tools: { absent: true } }, { ...request, tools: [] })).toBe(true);
    expect(matchesWhen({ tools: { includes: 'read_file' } }, { ...request, tools: [] })).toBe(false);
  });

  test('a null maxTokens never matches a maxTokens matcher', () => {
    const noMax = { ...request, maxTokens: null };
    expect(matchesWhen({ maxTokens: { lt: 1000 } }, noMax)).toBe(false);
    expect(matchesWhen({ maxTokens: { gt: 0 } }, noMax)).toBe(false);
    expect(matchesWhen({ maxTokens: { equals: 0 } }, noMax)).toBe(false);
  });

  test('an empty system matches only empty-string predicates', () => {
    const noSystem = { ...request, system: [] };
    expect(matchesWhen({ system: { equals: '' } }, noSystem)).toBe(true);
    expect(matchesWhen({ system: { contains: 'title' } }, noSystem)).toBe(false);
  });
});
