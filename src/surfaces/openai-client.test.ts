// The AI SDK client-verification test (story 5 acceptance criterion): a real
// consumer library -- `@ai-sdk/openai-compatible` + `ai`, the same packages
// OpenCode and Kilo use to select their OpenAI-compatible client
// (opencode/packages/opencode/src/provider/provider.ts:1691-1712) -- drives
// the running server over the wire with a placeholder key. This is the proof
// the fragmented tool-call delta stream is shaped the way a real client
// expects, not just the way a hand-written reader accepts.
//
// Dev-only dependency (STANDARDS.md, epic P2): nothing here ships in the
// runtime surface.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText, tool } from 'ai';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { startServer, type ServerHandle } from '../core/server.js';

const scenario = {
  responses: [
    {
      say: "I'll check the weather for you.",
      calls: [{ tool: 'get_weather', with: { city: 'Springfield', unit: 'celsius' } }],
      usage: { input: 24, output: 12 },
    },
  ],
};

const nonStreamingScenario = {
  responses: [{ say: 'Hello from llmdouble.', usage: { input: 12, output: 5 } }],
};

const open: ServerHandle[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close().catch(() => undefined);
});

async function client(scenarioValue: unknown) {
  const server = await startServer({ scenario: scenarioValue as Parameters<typeof startServer>[0]['scenario'] });
  open.push(server);
  const provider = createOpenAICompatible({ name: 'llmdouble', baseURL: `${server.url}/v1`, apiKey: 'placeholder-key' });
  return { model: provider.chatModel('stub-model'), server };
}

describe('AI SDK client verification', () => {
  test('streamText with a tool defined: the tool call arrives with the scripted name and parsed arguments, and the text arrives intact', async () => {
    const { model } = await client(scenario);
    const result = streamText({
      model,
      prompt: "what's the weather in Springfield?",
      tools: {
        get_weather: tool({
          description: 'Get the weather for a city.',
          inputSchema: z.object({ city: z.string(), unit: z.enum(['celsius', 'fahrenheit']) }),
        }),
      },
    });

    const text = await result.text;
    const toolCalls = await result.toolCalls;

    expect(text).toBe("I'll check the weather for you.");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ toolName: 'get_weather', input: { city: 'Springfield', unit: 'celsius' } });

    const finishReason = await result.finishReason;
    expect(finishReason).toBe('tool-calls');
  });

  test('generateText for the non-streaming path returns the scripted text', async () => {
    const { model } = await client(nonStreamingScenario);
    const result = await generateText({ model, prompt: 'hello' });
    expect(result.text).toBe('Hello from llmdouble.');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(5);
  });

  test('generateText with a tool defined also parses the tool call correctly', async () => {
    const { model } = await client(scenario);
    const result = await generateText({
      model,
      prompt: "what's the weather in Springfield?",
      tools: {
        get_weather: tool({
          description: 'Get the weather for a city.',
          inputSchema: z.object({ city: z.string(), unit: z.enum(['celsius', 'fahrenheit']) }),
        }),
      },
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ toolName: 'get_weather', input: { city: 'Springfield', unit: 'celsius' } });
    expect(result.text).toBe("I'll check the weather for you.");
  });
});
