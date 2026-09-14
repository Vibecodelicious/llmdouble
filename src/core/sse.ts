// Server-sent events text: one `event:` line and one `data:` line per event,
// blank-line terminated. Shared by every streaming surface and by the tests
// that read a recorded `responseBody` back.

export interface SseEvent {
  event: string;
  data: unknown;
}

/** Serialise events as SSE text. */
export function formatSse(events: SseEvent[]): string {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** Parse SSE text produced by `formatSse`. Throws on any block that is not an `event:` line followed by a `data:` line. */
export function parseSse(text: string): SseEvent[] {
  if (text === '') return [];
  if (!text.endsWith('\n\n')) throw new Error('SSE text must end with a blank line');
  return text
    .slice(0, -2)
    .split('\n\n')
    .map((block, i) => {
      const lines = block.split('\n');
      if (lines.length !== 2 || !lines[0]!.startsWith('event: ') || !lines[1]!.startsWith('data: ')) {
        throw new Error(`SSE block ${i + 1} is not an event line followed by a data line: ${JSON.stringify(block)}`);
      }
      return { event: lines[0]!.slice(7), data: JSON.parse(lines[1]!.slice(6)) as unknown };
    });
}
