#!/usr/bin/env node
// A stand-in for a harness with a feature flag. Plain Node, no dependencies.
//
// It sends two Anthropic Messages requests to ANTHROPIC_BASE_URL. The first
// carries an instruction and, as a second user message, the file the
// instruction refers to, marked `[archive-me]`. The second carries the first
// reply as history plus a new instruction. With ECHO_FEATURE=1 the marked
// message is replaced by the placeholder `[archived]` before the second
// request, the way a context manager that archives stale content would; with
// the flag off the transcript is sent as it is. Either way the reply text is
// printed, one line per turn.
//
//   ANTHROPIC_BASE_URL=http://127.0.0.1:<port> ECHO_FEATURE=1 node examples/echo-client/client.mjs

const base = process.env.ANTHROPIC_BASE_URL;
if (!base) {
  console.error('ANTHROPIC_BASE_URL is required');
  process.exit(2);
}
const featureOn = process.env.ECHO_FEATURE === '1';

const parserSource = [
  'export function parse(source) {',
  '  const tokens = lex(source);',
  '  const tree = build(tokens);',
  '  return lower(tree);',
  '}',
].join('\n');

const transcript = [
  { role: 'user', content: 'step one: summarise the parser I attached.' },
  { role: 'user', content: `[archive-me] src/parser.ts:\n${parserSource}` },
];

const first = await ask(transcript);
transcript.push({ role: 'assistant', content: first });
if (featureOn) {
  const stale = transcript.findIndex((message) => message.content.includes('[archive-me]'));
  transcript[stale] = { role: 'user', content: '[archived]' };
}
transcript.push({ role: 'user', content: 'step two: thanks, that is all.' });
const second = await ask(transcript);
console.log(first);
console.log(second);

async function ask(messages) {
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? 'x',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      stream: true,
      system: 'You are a terse assistant.',
      tools: [
        {
          name: 'read_file',
          description: 'Read a file from the workspace.',
          input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
      messages,
    }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} from ${base}: ${body}`);
  return textOf(body);
}

/** The concatenated `text_delta` text of an SSE stream. */
function textOf(sse) {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((event) => event.type === 'content_block_delta' && event.delta.type === 'text_delta')
    .map((event) => event.delta.text)
    .join('');
}
