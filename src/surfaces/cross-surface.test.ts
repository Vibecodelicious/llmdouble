// Proves one scenario yields the same normalised recording on both surfaces
// (story 5's acceptance criterion): drive the same scenario with an
// Anthropic-shaped client and an OpenAI-shaped client and assert identical
// `served` sequences, identical `tools.registered`, identical user/assistant
// `messages.texts`, and identical scripted stop reasons after mapping
// (end_turn <-> stop, tool_use <-> tool_calls).

import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { load } from '../assert/load.js';
import type { Recording } from '../assert/recording.js';
import { startServer, type ServerHandle } from '../core/server.js';
import { parseSse } from '../core/sse.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCENARIO = join(ROOT, 'examples', 'scenarios', 'tool-call.json');
const dir = mkdtempSync(join(tmpdir(), 'llmdouble-cross-surface-'));

function post(url: string, path: string, body: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const open: ServerHandle[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

/** Drive the tool-call scenario's two turns (a tool call, then a tool-result continuation) against one surface. */
async function driveAnthropic(record: string): Promise<Recording> {
  const server = await startServer({ scenario: SCENARIO, record });
  open.push(server);
  await post(
    server.url,
    '/v1/messages',
    JSON.stringify({
      model: 'claude-sonnet-4-6',
      stream: true,
      max_tokens: 1024,
      messages: [{ role: 'user', content: "what's the weather in Springfield?" }],
      tools: [{ name: 'get_weather' }],
    }),
  );
  await post(
    server.url,
    '/v1/messages',
    JSON.stringify({
      model: 'claude-sonnet-4-6',
      stream: true,
      max_tokens: 1024,
      messages: [
        { role: 'user', content: "what's the weather in Springfield?" },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Springfield', unit: 'celsius' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '21C, clear' }] },
      ],
      tools: [{ name: 'get_weather' }],
    }),
  );
  return open.pop()!.close();
}

async function driveOpenAI(record: string): Promise<Recording> {
  const server = await startServer({ scenario: SCENARIO, record });
  open.push(server);
  await post(
    server.url,
    '/v1/chat/completions',
    JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: "what's the weather in Springfield?" }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
    }),
  );
  await post(
    server.url,
    '/v1/chat/completions',
    JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: "what's the weather in Springfield?" },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Springfield","unit":"celsius"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '21C, clear' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: {} } }],
    }),
  );
  return open.pop()!.close();
}

/** The stop reason the scripted response's SSE/JSON body carries, mapped to a surface-neutral name. */
function anthropicStopReason(responseBody: string): string {
  const delta = parseSse(responseBody).find((e) => e.event === 'message_delta')?.data as { delta: { stop_reason: string } };
  return delta.delta.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn';
}

function openaiStopReason(responseBody: string): string {
  const body = JSON.parse(responseBody) as { choices: [{ finish_reason: string }] };
  return body.choices[0]!.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
}

describe('cross-surface: one scenario, two wire formats', () => {
  test('identical served sequences, tools.registered, messages.texts, and mapped stop reasons', async () => {
    const anthropic = await driveAnthropic(join(dir, 'anthropic.jsonl'));
    const openai = await driveOpenAI(join(dir, 'openai.jsonl'));

    expect(anthropic.count).toBe(2);
    expect(openai.count).toBe(2);

    // Identical served sequences: both turns come from the same scripted responses in order.
    expect(anthropic.requests.map((r) => r.served)).toEqual(openai.requests.map((r) => r.served));

    // Identical tools.registered.
    expect(anthropic.first.tools.registered).toEqual(['get_weather']);
    expect(openai.first.tools.registered).toEqual(['get_weather']);
    expect(anthropic.last.tools.registered).toEqual(openai.last.tools.registered);

    // Identical user/assistant messages.texts (the tool-call turn: user text, then assistant's call as
    // its JSON input -- the normaliser's messageText concatenates a tool_use block's input as JSON).
    expect(anthropic.first.messages.texts).toEqual(["what's the weather in Springfield?"]);
    expect(openai.first.messages.texts).toEqual(anthropic.first.messages.texts);

    const anthropicCallText = anthropic.last.messages.texts[1];
    const openaiCallText = openai.last.messages.texts[1];
    expect(anthropicCallText).toBeDefined();
    expect(JSON.parse(anthropicCallText!)).toEqual(JSON.parse(openaiCallText!));
    expect(anthropic.last.messages.texts[0]).toEqual(openai.last.messages.texts[0]);
    expect(anthropic.last.messages.texts[2]).toEqual(openai.last.messages.texts[2]); // the tool result text

    // Identical scripted stop reasons after mapping (end_turn<->stop, tool_use<->tool_calls).
    expect(anthropicStopReason(anthropic.first.responseBody)).toBe('tool_use');
    expect(openaiStopReason(openai.first.responseBody)).toBe('tool_use');
    expect(anthropicStopReason(anthropic.last.responseBody)).toBe('end_turn');
    expect(openaiStopReason(openai.last.responseBody)).toBe('end_turn');
  });

  test('load() reads both recordings back identically shaped', async () => {
    const anthropicPath = join(dir, 'anthropic-reload.jsonl');
    const openaiPath = join(dir, 'openai-reload.jsonl');
    await driveAnthropic(anthropicPath);
    await driveOpenAI(openaiPath);
    const anthropic = load(anthropicPath);
    const openai = load(openaiPath);
    expect(anthropic.summary).toEqual(openai.summary);
  });
});
