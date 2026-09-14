import { describe, expect, test } from 'vitest';
import { IdCounters } from '../core/ids.js';
import type { NormalizedRequest } from '../core/normalize.js';
import { parseSse } from '../core/sse.js';
import { renderAnthropicResponse, renderAnthropicStream } from './anthropic.js';

/** Parsed events with object data, for property access in assertions. */
function events(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return parseSse(text).map((e) => ({ event: e.event, data: e.data as Record<string, unknown> }));
}

const normalized: NormalizedRequest = {
  model: 'claude-sonnet-4-6',
  stream: true,
  maxTokens: 1024,
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
};

describe('renderAnthropicStream', () => {
  test('a text response streams the full lifecycle with usage in place', () => {
    const evs = events(renderAnthropicStream({ say: 'Hello there.', usage: { input: 42, output: 7 } }, { normalized, ids: new IdCounters() }));
    expect(evs.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(evs.every((e) => e.data.type === e.event)).toBe(true);
    expect(evs[0]!.data.message).toEqual({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    });
    expect(evs[1]!.data).toEqual({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    expect(evs[2]!.data).toEqual({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello there.' } });
    expect(evs[3]!.data).toEqual({ type: 'content_block_stop', index: 0 });
    expect(evs[4]!.data).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 },
    });
    expect(evs[5]!.data).toEqual({ type: 'message_stop' });
  });

  test('tool calls become tool_use blocks with input_json_delta and stop_reason tool_use', () => {
    const ids = new IdCounters();
    const text = renderAnthropicStream(
      {
        say: "I'll read that file first.",
        calls: [
          { tool: 'read_file', with: { path: 'src/parser.ts' } },
          { tool: 'list_dir' },
        ],
      },
      { normalized, ids },
    );
    const evs = events(text);
    expect(evs.map((e) => `${e.event}${'index' in e.data ? `[${e.data.index}]` : ''}`)).toEqual([
      'message_start',
      'content_block_start[0]',
      'content_block_delta[0]',
      'content_block_stop[0]',
      'content_block_start[1]',
      'content_block_delta[1]',
      'content_block_stop[1]',
      'content_block_start[2]',
      'content_block_delta[2]',
      'content_block_stop[2]',
      'message_delta',
      'message_stop',
    ]);
    expect(evs[4]!.data.content_block).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} });
    expect(evs[5]!.data.delta).toEqual({ type: 'input_json_delta', partial_json: '{"path":"src/parser.ts"}' });
    expect(evs[7]!.data.content_block).toEqual({ type: 'tool_use', id: 'toolu_2', name: 'list_dir', input: {} });
    expect(evs[8]!.data.delta).toEqual({ type: 'input_json_delta', partial_json: '{}' });
    expect((evs[10]!.data.delta as { stop_reason: string }).stop_reason).toBe('tool_use');
    expect((evs[10]!.data.usage as { output_tokens: number }).output_tokens).toBe(0);
    expect(text).not.toContain('[DONE]');
  });

  test('an empty say with calls emits only the tool block', () => {
    const evs = events(renderAnthropicStream({ say: '', calls: [{ tool: 't' }] }, { normalized, ids: new IdCounters() }));
    expect(evs.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect((evs[1]!.data.content_block as { type: string }).type).toBe('tool_use');
  });

  test('ids are monotonic across responses on one counter', () => {
    const ids = new IdCounters();
    const ctx = { normalized, ids };
    const first = events(renderAnthropicStream({ say: 'a', calls: [{ tool: 't' }] }, ctx));
    const second = events(renderAnthropicStream({ say: 'b', calls: [{ tool: 't' }, { tool: 'u' }] }, ctx));
    expect((first[0]!.data.message as { id: string }).id).toBe('msg_1');
    expect((second[0]!.data.message as { id: string }).id).toBe('msg_2');
    expect((first[4]!.data.content_block as { id: string }).id).toBe('toolu_1');
    expect((second[4]!.data.content_block as { id: string }).id).toBe('toolu_2');
    expect((second[7]!.data.content_block as { id: string }).id).toBe('toolu_3');
  });

  test('renderAnthropicResponse sets the event-stream headers', () => {
    const rendered = renderAnthropicResponse({ say: 'x' }, { normalized, ids: new IdCounters() });
    expect(rendered.status).toBe(200);
    expect(rendered.headers).toEqual({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    expect(rendered.body).toBe(renderAnthropicStream({ say: 'x' }, { normalized, ids: new IdCounters() }));
  });
});
