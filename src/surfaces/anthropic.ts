// The Anthropic Messages surface: `POST /v1/messages`, streaming only (epic P4).
//
// `parse` turns a wire body into the normalised view; `render` turns a
// scripted response into the SSE event sequence the Messages API streams:
// message_start, then per content block content_block_start /
// content_block_delta / content_block_stop, then message_delta carrying the
// stop reason and output usage, then message_stop. Shapes are ported by
// reference from the judged predecessor `scripts/fake-anthropic-provider.mjs`
// (branch showrunner/fake-llm-live-fix).

import { opaqueBlock, type NormalizedBlock, type NormalizedMessage, type NormalizedRequest } from '../core/normalize.js';
import { formatSse, type SseEvent } from '../core/sse.js';
import { callsOf, usageOf, type ScriptedResponse } from '../core/scenario.js';
import type { ParseResult, RenderContext, Rendered, Surface } from '../core/server.js';

export const ANTHROPIC_PATH = '/v1/messages';

export const ANTHROPIC_ERRORS = {
  invalidRequest: {
    status: 400,
    type: 'invalid_request',
    message: 'Request must include a non-empty model, a non-empty messages array, and stream=true.',
  },
  streamRequired: {
    status: 422,
    type: 'stream_required',
    message: 'Only streaming Anthropic Messages requests are supported.',
  },
} as const;

export const anthropicSurface: Surface = {
  name: 'anthropic',
  path: ANTHROPIC_PATH,
  parse: parseAnthropicRequest,
  render: renderAnthropicResponse,
};

/** Validate a Messages request body and produce the normalised view. */
export function parseAnthropicRequest(body: Record<string, unknown>): ParseResult {
  const invalid: ParseResult = { ok: false, error: ANTHROPIC_ERRORS.invalidRequest };
  if (typeof body.model !== 'string' || body.model.length === 0) return invalid;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return invalid;
  const messages: NormalizedMessage[] = [];
  for (const message of body.messages) {
    if (!isRecord(message) || typeof message.role !== 'string') return invalid;
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) return invalid;
    messages.push({ role: message.role, content: normalizeContent(message.content) });
  }
  if (body.system !== undefined && typeof body.system !== 'string' && !Array.isArray(body.system)) return invalid;
  if (body.tools !== undefined && !Array.isArray(body.tools)) return invalid;
  if (body.stream !== true) return { ok: false, error: ANTHROPIC_ERRORS.streamRequired };

  const normalized: NormalizedRequest = {
    model: body.model,
    stream: true,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
    system: normalizeSystem(body.system),
    messages,
    tools: (body.tools ?? [])
      .filter((tool): tool is Record<string, unknown> => isRecord(tool) && typeof tool.name === 'string')
      .map((tool) => ({ name: tool.name as string })),
  };
  return { ok: true, normalized };
}

function normalizeSystem(system: unknown): Array<{ text: string }> {
  if (system === undefined) return [];
  if (typeof system === 'string') return [{ text: system }];
  return (system as unknown[]).map((block) =>
    isRecord(block) && block.type === 'text' && typeof block.text === 'string'
      ? { text: block.text }
      : { text: JSON.stringify(block) ?? '' },
  );
}

function normalizeContent(content: string | unknown[]): NormalizedBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map(normalizeBlock);
}

function normalizeBlock(block: unknown): NormalizedBlock {
  if (!isRecord(block)) return opaqueBlock(block);
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'tool_use' && typeof block.name === 'string') {
    return { type: 'tool_use', id: typeof block.id === 'string' ? block.id : '', name: block.name, input: block.input };
  }
  if (block.type === 'tool_result') {
    return {
      type: 'tool_result',
      toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
      text: toolResultText(block.content),
    };
  }
  return opaqueBlock(block);
}

function toolResultText(content: unknown): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : JSON.stringify(block) ?? ''))
      .join('');
  }
  return JSON.stringify(content) ?? '';
}

/** Render a scripted response as the Messages streaming body. */
export function renderAnthropicResponse(response: ScriptedResponse, ctx: RenderContext): Rendered {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
    body: renderAnthropicStream(response, ctx),
  };
}

/** The SSE text for one scripted response: `event:` and `data:` lines per event, no `[DONE]` sentinel. */
export function renderAnthropicStream(response: ScriptedResponse, ctx: RenderContext): string {
  const usage = usageOf(response);
  const calls = callsOf(response);
  const events: SseEvent[] = [];
  events.push({
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: ctx.ids.next('msg_'),
        type: 'message',
        role: 'assistant',
        model: ctx.normalized.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      },
    },
  });
  let index = 0;
  if (response.say !== '') {
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
    events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: response.say } } });
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    index += 1;
  }
  for (const call of calls) {
    const id = ctx.ids.next('toolu_');
    events.push({
      event: 'content_block_start',
      data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: call.tool, input: {} } },
    });
    events.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.with ?? {}) } },
    });
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
    index += 1;
  }
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: calls.length > 0 ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { input_tokens: usage.input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: usage.output },
    },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return formatSse(events);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
