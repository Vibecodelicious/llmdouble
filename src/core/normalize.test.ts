import { describe, expect, test } from 'vitest';
import { parseAnthropicRequest } from '../surfaces/anthropic.js';
import { messageText, opaqueBlock, systemText, type NormalizedMessage } from './normalize.js';

describe('Anthropic parser -> NormalizedRequest', () => {
  const body = {
    model: 'claude-sonnet-4-6',
    stream: true,
    max_tokens: 1024,
    system: [
      { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Be brief.' },
    ],
    messages: [
      { role: 'user', content: 'help me refactor the parser' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading it.' },
          { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'src/parser.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: 'export function parse() {}' }] },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'plain result' }] },
    ],
    tools: [{ name: 'read_file', input_schema: { type: 'object' } }, { name: 'write_file' }, { type: 'bash_20250124' }],
  };

  test('reduces every block kind and keeps messages aligned one-to-one', () => {
    const result = parseAnthropicRequest(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized).toEqual({
      model: 'claude-sonnet-4-6',
      stream: true,
      maxTokens: 1024,
      system: [{ text: 'You are helpful.' }, { text: 'Be brief.' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'help me refactor the parser' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading it.' },
            { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'src/parser.ts' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'toolu_01', text: 'export function parse() {}' },
            { type: 'text', text: JSON.stringify(body.messages[2]!.content[1]) },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_02', text: 'plain result' }] },
      ],
      tools: [{ name: 'read_file' }, { name: 'write_file' }],
    });
    expect(result.normalized.messages).toHaveLength(body.messages.length);
  });

  test('a string system becomes one block; a missing system is empty', () => {
    const withString = parseAnthropicRequest({ ...body, system: 'Just text.' });
    expect(withString.ok && withString.normalized.system).toEqual([{ text: 'Just text.' }]);
    const { system: _dropped, ...withoutSystem } = body;
    const none = parseAnthropicRequest(withoutSystem);
    expect(none.ok && none.normalized.system).toEqual([]);
  });

  test('a non-text system block is reduced to its JSON', () => {
    const odd = { type: 'other', value: 1 };
    const result = parseAnthropicRequest({ ...body, system: [odd] });
    expect(result.ok && result.normalized.system).toEqual([{ text: JSON.stringify(odd) }]);
  });

  test('max_tokens absent or non-numeric normalises to null; tools absent to []', () => {
    const { max_tokens: _m, tools: _t, ...rest } = body;
    const result = parseAnthropicRequest(rest);
    expect(result.ok && result.normalized.maxTokens).toBeNull();
    expect(result.ok && result.normalized.tools).toEqual([]);
  });

  test.each<[string, Record<string, unknown>, number, string]>([
    ['missing model', { ...body, model: undefined }, 400, 'invalid_request'],
    ['empty model', { ...body, model: '' }, 400, 'invalid_request'],
    ['missing messages', { ...body, messages: undefined }, 400, 'invalid_request'],
    ['empty messages', { ...body, messages: [] }, 400, 'invalid_request'],
    ['message without role', { ...body, messages: [{ content: 'x' }] }, 400, 'invalid_request'],
    ['message content wrong type', { ...body, messages: [{ role: 'user', content: 5 }] }, 400, 'invalid_request'],
    ['system wrong type', { ...body, system: 5 }, 400, 'invalid_request'],
    ['tools wrong type', { ...body, tools: 'read_file' }, 400, 'invalid_request'],
    ['stream false', { ...body, stream: false }, 422, 'stream_required'],
    ['stream missing', { ...body, stream: undefined }, 422, 'stream_required'],
  ])('rejects %s', (_label, value, status, type) => {
    const result = parseAnthropicRequest(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(status);
    expect(result.error.type).toBe(type);
  });
});

describe('text views', () => {
  test('messageText concatenates every block: text, tool input JSON, tool result text', () => {
    const message: NormalizedMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'a' },
        { type: 'tool_use', id: 'toolu_1', name: 't', input: { k: 1 } },
        { type: 'tool_result', toolUseId: 'toolu_1', text: 'b' },
      ],
    };
    expect(messageText(message)).toBe('a{"k":1}b');
  });

  test('systemText joins blocks with newlines', () => {
    expect(systemText({ model: '', stream: true, maxTokens: null, system: [{ text: 'x' }, { text: 'y' }], messages: [], tools: [] })).toBe('x\ny');
  });

  test('opaqueBlock holds the raw JSON', () => {
    expect(opaqueBlock({ type: 'thinking', thinking: '...' })).toEqual({ type: 'text', text: '{"type":"thinking","thinking":"..."}' });
  });
});
