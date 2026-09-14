// The OpenAI chat-completions surface: `POST /v1/chat/completions`, both
// streaming and non-streaming (epic P4). `parse` turns a wire body into the
// normalised view; `render` turns a scripted response into either a
// `chat.completion` object or a `chat.completion.chunk` SSE stream ending in
// `[DONE]`. Shapes are ported by reference from the judged predecessor
// `hermes_context_bonsai/tools/stub_provider.py` (epic P8); the fragmented
// tool-call delta shape is the hardest sub-case and is verified against a
// real AI SDK client in `openai-client.test.ts`, not a hand-written reader.

import { opaqueBlock, type NormalizedBlock, type NormalizedMessage, type NormalizedRequest } from '../core/normalize.js';
import { callsOf, usageOf, type ScriptedResponse } from '../core/scenario.js';
import type { ParseResult, RenderContext, Rendered, Surface } from '../core/server.js';

export const OPENAI_PATH = '/v1/chat/completions';

/** Content is fragmented into pieces this size (in JSON characters) for the streamed argument deltas. */
const TOOL_ARGUMENT_CHUNK_SIZE = 24;

export const OPENAI_ERRORS = {
  invalidRequest: {
    status: 400,
    type: 'invalid_request',
    message: 'Request must include a non-empty model and a non-empty messages array.',
  },
} as const;

export const openaiSurface: Surface = {
  name: 'openai',
  path: OPENAI_PATH,
  parse: parseOpenAIRequest,
  render: renderOpenAIResponse,
};

/** Validate a chat-completions request body and produce the normalised view. There is no 422 on this surface (story AC). */
export function parseOpenAIRequest(body: Record<string, unknown>): ParseResult {
  const invalid: ParseResult = { ok: false, error: OPENAI_ERRORS.invalidRequest };
  if (typeof body.model !== 'string' || body.model.length === 0) return invalid;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return invalid;
  const messages: NormalizedMessage[] = [];
  for (const message of body.messages) {
    if (!isRecord(message) || typeof message.role !== 'string') return invalid;
    if (message.content !== undefined && message.content !== null && typeof message.content !== 'string' && !Array.isArray(message.content)) {
      return invalid;
    }
    messages.push({ role: message.role, content: normalizeMessageContent(message) });
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) return invalid;
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;

  const normalized: NormalizedRequest = {
    model: body.model,
    stream: body.stream === true,
    maxTokens: typeof maxTokens === 'number' ? maxTokens : null,
    system: systemMessagesOf(messages),
    messages,
    tools: (body.tools ?? [])
      .filter((tool): tool is Record<string, unknown> => isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === 'string')
      .map((tool) => ({ name: (tool.function as Record<string, unknown>).name as string })),
  };
  return { ok: true, normalized };
}

/** `normalized.system` is a view over system-role messages; `messages` keeps them as sent (C3). */
function systemMessagesOf(messages: NormalizedMessage[]): Array<{ text: string }> {
  return messages.filter((message) => message.role === 'system').map((message) => ({ text: messageContentText(message.content) }));
}

function messageContentText(content: NormalizedBlock[]): string {
  return content.map((block) => (block.type === 'text' ? block.text : JSON.stringify(block) ?? '')).join('');
}

/** Assistant `tool_calls` become `tool_use` blocks; `tool`-role content becomes a `tool_result` block; otherwise ordinary content. */
function normalizeMessageContent(message: Record<string, unknown>): NormalizedBlock[] {
  if (message.role === 'tool') {
    return [
      {
        type: 'tool_result',
        toolUseId: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
        text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') ?? '',
      },
    ];
  }
  const blocks = normalizeContent(message.content ?? '');
  if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== 'string') continue;
      blocks.push({
        type: 'tool_use',
        id: typeof call.id === 'string' ? call.id : '',
        name: call.function.name,
        input: parseToolArguments(call.function.arguments),
      });
    }
  }
  return blocks;
}

function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function normalizeContent(content: unknown): NormalizedBlock[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map(normalizePart);
}

/** A `text` part is kept; an `image_url` part (and anything else unmodelled) is reduced to a text block holding its JSON. */
function normalizePart(part: unknown): NormalizedBlock {
  if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
  return opaqueBlock(part);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Render a scripted response as either a `chat.completion` object or a `chat.completion.chunk` stream. */
export function renderOpenAIResponse(response: ScriptedResponse, ctx: RenderContext): Rendered {
  if (!ctx.normalized.stream) return renderOpenAINonStream(response, ctx);
  const streamOptions = ctx.raw?.stream_options;
  const includeUsage = isRecord(streamOptions) && streamOptions.include_usage === true;
  return renderOpenAIStream(response, ctx, includeUsage);
}

function stopReason(calls: ReturnType<typeof callsOf>): 'stop' | 'tool_calls' {
  return calls.length > 0 ? 'tool_calls' : 'stop';
}

/** The non-streaming `chat.completion` object. */
function renderOpenAINonStream(response: ScriptedResponse, ctx: RenderContext): Rendered {
  const usage = usageOf(response);
  const calls = callsOf(response);
  const id = ctx.ids.next('chatcmpl-');
  const message: Record<string, unknown> = { role: 'assistant', content: response.say };
  if (calls.length > 0) {
    message.tool_calls = calls.map((call) => ({
      id: ctx.ids.next('call_'),
      type: 'function',
      function: { name: call.tool, arguments: JSON.stringify(call.with ?? {}) },
    }));
  }
  const body = {
    id,
    object: 'chat.completion',
    created: 0,
    model: ctx.normalized.model,
    choices: [{ index: 0, message, finish_reason: stopReason(calls) }],
    usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
  };
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * The streaming `chat.completion.chunk` sequence, in order: a first chunk carrying `delta.role`,
 * content chunks, tool-call fragment chunks (id/name/`arguments: ""` first, then argument fragments
 * split at a fixed size), a closing chunk with `finish_reason`, a usage-only chunk (`choices: []`) if
 * `stream_options.include_usage` was requested, then `[DONE]`.
 */
function renderOpenAIStream(response: ScriptedResponse, ctx: RenderContext, includeUsage: boolean): Rendered {
  const usage = usageOf(response);
  const calls = callsOf(response);
  const id = ctx.ids.next('chatcmpl-');
  const base = { id, object: 'chat.completion.chunk', created: 0, model: ctx.normalized.model };

  const dataLines: unknown[] = [];
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
    dataLines.push({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] });
  };

  chunk({ role: 'assistant' });
  if (response.say !== '') chunk({ content: response.say });
  for (const [index, call] of calls.entries()) {
    const toolId = ctx.ids.next('call_');
    chunk({ tool_calls: [{ index, id: toolId, type: 'function', function: { name: call.tool, arguments: '' } }] });
    const args = JSON.stringify(call.with ?? {});
    for (const fragment of fragments(args, TOOL_ARGUMENT_CHUNK_SIZE)) {
      chunk({ tool_calls: [{ index, function: { arguments: fragment } }] });
    }
  }
  chunk({}, stopReason(calls));
  if (includeUsage) {
    dataLines.push({
      ...base,
      choices: [],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    });
  }

  const text = `${dataLines.map((data) => `data: ${JSON.stringify(data)}\n\n`).join('')}data: [DONE]\n\n`;
  return { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }, body: text };
}

/** Split `text` into non-empty chunks of at most `size` characters, preserving order. */
function fragments(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
