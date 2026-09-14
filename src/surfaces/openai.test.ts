import { describe, expect, test } from 'vitest';
import { IdCounters } from '../core/ids.js';
import { parseOpenAIRequest, renderOpenAIResponse } from './openai.js';

/** Parse `data:` lines out of the SSE text this surface writes (no `event:` line, unlike Anthropic's). */
function dataLines(text: string): unknown[] {
  expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  const body = text.slice(0, -('data: [DONE]\n\n'.length));
  if (body === '') return [];
  return body
    .split('\n\n')
    .filter((block) => block.length > 0)
    .map((block) => JSON.parse(block.slice('data: '.length)) as unknown);
}

function ctx(raw: Record<string, unknown>) {
  const parsed = parseOpenAIRequest(raw);
  if (!parsed.ok) throw new Error(`expected a valid request, got ${JSON.stringify(parsed.error)}`);
  return { normalized: parsed.normalized, ids: new IdCounters(), raw };
}

describe('parseOpenAIRequest', () => {
  test('rejects a missing model or empty messages', () => {
    expect(parseOpenAIRequest({ messages: [{ role: 'user', content: 'hi' }] })).toEqual({
      ok: false,
      error: { status: 400, type: 'invalid_request', message: expect.any(String) as unknown },
    });
    expect(parseOpenAIRequest({ model: 'gpt-4o', messages: [] })).toMatchObject({ ok: false });
  });

  test('string content becomes one text block', () => {
    const parsed = parseOpenAIRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'help me refactor' }] });
    expect(parsed).toMatchObject({
      ok: true,
      normalized: { messages: [{ role: 'user', content: [{ type: 'text', text: 'help me refactor' }] }] },
    });
  });

  test('array content keeps text parts and reduces image_url parts to a text block holding the JSON', () => {
    const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } };
    const parsed = parseOpenAIRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look at this' }, imagePart] }],
    });
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.normalized.messages[0]!.content).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'text', text: JSON.stringify(imagePart) },
    ]);
  });

  test('assistant tool_calls become tool_use blocks with parsed arguments', () => {
    const parsed = parseOpenAIRequest({
      model: 'gpt-4o',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
        },
      ],
    });
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.normalized.messages[0]!.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
    ]);
  });

  test('a tool-role message becomes a tool_result block carrying toolUseId', () => {
    const parsed = parseOpenAIRequest({
      model: 'gpt-4o',
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: '340 lines' }],
    });
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.normalized.messages[0]!.content).toEqual([{ type: 'tool_result', toolUseId: 'call_1', text: '340 lines' }]);
  });

  test('a tool-role message with array content joins its text parts, so no JSON syntax leaks into the region text', () => {
    const parsed = parseOpenAIRequest({
      model: 'gpt-4o',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [
            { type: 'text', text: 'result part 1' },
            { type: 'text', text: 'result part 2' },
          ],
        },
      ],
    });
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.normalized.messages[0]!.content[0]).toEqual({
      type: 'tool_result',
      toolUseId: 'call_1',
      text: 'result part 1result part 2',
    });
  });

  test('tools[].function.name becomes tools[].name', () => {
    const parsed = parseOpenAIRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
    });
    expect(parsed).toMatchObject({ ok: true, normalized: { tools: [{ name: 'read_file' }] } });
  });

  test('max_tokens and max_completion_tokens both map to maxTokens, the latter when both could apply', () => {
    const withMaxTokens = parseOpenAIRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 512 });
    expect(withMaxTokens).toMatchObject({ ok: true, normalized: { maxTokens: 512 } });
    const withMaxCompletionTokens = parseOpenAIRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      max_completion_tokens: 256,
    });
    expect(withMaxCompletionTokens).toMatchObject({ ok: true, normalized: { maxTokens: 256 } });
    const neither = parseOpenAIRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    expect(neither).toMatchObject({ ok: true, normalized: { maxTokens: null } });
  });

  test('stream defaults to false and is read from the body', () => {
    const notStreaming = parseOpenAIRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    expect(notStreaming).toMatchObject({ ok: true, normalized: { stream: false } });
    const streaming = parseOpenAIRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect(streaming).toMatchObject({ ok: true, normalized: { stream: true } });
  });

  test('normalized.system views system-role messages while messages keeps the system role as sent', () => {
    const parsed = parseOpenAIRequest({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'you are a careful editor' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(parsed).toMatchObject({
      ok: true,
      normalized: {
        system: [{ text: 'you are a careful editor' }],
        messages: [{ role: 'system', content: [{ type: 'text', text: 'you are a careful editor' }] }, { role: 'user' }],
      },
    });
  });
});

describe('renderOpenAIResponse: non-streaming', () => {
  test('a text response is a chat.completion object with usage from the scripted response', () => {
    const rendered = renderOpenAIResponse(
      { say: 'Hello there.', usage: { input: 42, output: 7 } },
      ctx({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(rendered.status).toBe(200);
    expect(rendered.headers['content-type']).toBe('application/json');
    const body = JSON.parse(rendered.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
    });
    expect(body.id).toMatch(/^chatcmpl-\d+$/);
  });

  test('a scripted call becomes a tool_calls entry with a JSON string of arguments and finish_reason tool_calls', () => {
    const rendered = renderOpenAIResponse(
      { say: '', calls: [{ tool: 'read_file', with: { path: 'src/parser.ts' } }] },
      ctx({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    );
    const body = JSON.parse(rendered.body) as {
      choices: [{ message: { tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }; finish_reason: string }];
    };
    expect(body.choices[0]!.finish_reason).toBe('tool_calls');
    const call = body.choices[0]!.message.tool_calls[0]!;
    expect(call.type).toBe('function');
    expect(call.id).toMatch(/^call_\d+$/);
    expect(call.function).toEqual({ name: 'read_file', arguments: '{"path":"src/parser.ts"}' });
  });

  test('ids are monotonic across responses on one shared counter', () => {
    const counters = new IdCounters();
    const request = ctx({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    const first = JSON.parse(renderOpenAIResponse({ say: 'a', calls: [{ tool: 't' }] }, { ...request, ids: counters }).body) as {
      id: string;
      choices: [{ message: { tool_calls: [{ id: string }] } }];
    };
    const second = JSON.parse(renderOpenAIResponse({ say: 'b', calls: [{ tool: 't' }] }, { ...request, ids: counters }).body) as {
      id: string;
      choices: [{ message: { tool_calls: [{ id: string }] } }];
    };
    expect(first.id).toBe('chatcmpl-1');
    expect(second.id).toBe('chatcmpl-2');
    expect(first.choices[0]!.message.tool_calls[0]!.id).toBe('call_1');
    expect(second.choices[0]!.message.tool_calls[0]!.id).toBe('call_2');
  });
});

describe('renderOpenAIResponse: streaming', () => {
  function streamOf(response: Parameters<typeof renderOpenAIResponse>[0], raw: Record<string, unknown> = {}) {
    const full = { model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'hi' }], ...raw };
    const rendered = renderOpenAIResponse(response, ctx(full));
    expect(rendered.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    return dataLines(rendered.body) as Array<{ choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }> }>;
  }

  test('a text response streams role, content, then a closing chunk with finish_reason stop, then [DONE]', () => {
    const chunks = streamOf({ say: 'Hello there.' });
    expect(chunks.map((c) => c.choices[0]!.delta)).toEqual([{ role: 'assistant' }, { content: 'Hello there.' }, {}]);
    expect(chunks.map((c) => c.choices[0]!.finish_reason)).toEqual([null, null, 'stop']);
  });

  test('a tool call streams id/name/empty-arguments first, then argument fragments, then finish_reason tool_calls', () => {
    const args = { path: 'src/parser.ts', recursive: true };
    const chunks = streamOf({ say: '', calls: [{ tool: 'read_file', with: args }] });
    // [role, tool-call-open, ...argument fragments, closing]
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: 'assistant' });
    const open = chunks[1]!.choices[0]!.delta as { tool_calls: Array<{ index: number; id: string; type: string; function: { name: string; arguments: string } }> };
    expect(open.tool_calls[0]).toMatchObject({ index: 0, type: 'function', function: { name: 'read_file', arguments: '' } });
    expect(open.tool_calls[0]!.id).toMatch(/^call_\d+$/);

    const fragmentChunks = chunks.slice(2, -1);
    expect(fragmentChunks.length).toBeGreaterThan(0);
    let reassembled = '';
    for (const fragmentChunk of fragmentChunks) {
      const delta = fragmentChunk.choices[0]!.delta as { tool_calls: Array<{ index: number; function: { arguments: string } }> };
      expect(delta.tool_calls[0]!.index).toBe(0);
      expect(delta.tool_calls[0]).not.toHaveProperty('id'); // id and name are on the first fragment only
      reassembled += delta.tool_calls[0]!.function.arguments;
    }
    expect(JSON.parse(reassembled)).toEqual(args);

    const closing = chunks[chunks.length - 1]!;
    expect(closing.choices[0]!.delta).toEqual({});
    expect(closing.choices[0]!.finish_reason).toBe('tool_calls');
  });

  test('multiple tool calls are indexed independently and can be reassembled by index', () => {
    const chunks = streamOf({
      say: '',
      calls: [
        { tool: 'read_file', with: { path: 'a.ts' } },
        { tool: 'list_dir', with: { path: '.' } },
      ],
    });
    const byIndex = new Map<number, string>();
    let names: Record<number, string> = {};
    for (const c of chunks) {
      const delta = c.choices[0]!.delta as { tool_calls?: Array<{ index: number; function?: { name?: string; arguments?: string } }> };
      for (const call of delta.tool_calls ?? []) {
        if (call.function?.name !== undefined) names = { ...names, [call.index]: call.function.name };
        byIndex.set(call.index, (byIndex.get(call.index) ?? '') + (call.function?.arguments ?? ''));
      }
    }
    expect(names).toEqual({ 0: 'read_file', 1: 'list_dir' });
    expect(JSON.parse(byIndex.get(0)!)).toEqual({ path: 'a.ts' });
    expect(JSON.parse(byIndex.get(1)!)).toEqual({ path: '.' });
  });

  test('stream_options.include_usage adds a trailing usage-only chunk with an empty choices array', () => {
    const withUsage = streamOf({ say: 'hi', usage: { input: 10, output: 2 } }, { stream_options: { include_usage: true } });
    const last = withUsage[withUsage.length - 1]! as unknown as { choices: unknown[]; usage?: Record<string, number> };
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });

    const withoutUsage = streamOf({ say: 'hi', usage: { input: 10, output: 2 } });
    const withoutLast = withoutUsage[withoutUsage.length - 1]! as unknown as { choices: unknown[] };
    expect(withoutLast.choices.length).toBe(1); // the ordinary closing chunk, not a usage-only one
  });

  test('an empty say with a call emits only the tool-call chunks between role and the closing chunk', () => {
    const chunks = streamOf({ say: '', calls: [{ tool: 't' }] });
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: 'assistant' });
    expect(chunks.some((c) => 'content' in c.choices[0]!.delta)).toBe(false);
  });
});
