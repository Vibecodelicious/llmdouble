import { describe, expect, test } from 'vitest';
import { formatSse, parseSse } from './sse.js';

describe('sse', () => {
  test('round-trips events as event/data line pairs', () => {
    const events = [
      { event: 'message_start', data: { type: 'message_start', n: 1 } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
    const text = formatSse(events);
    expect(text).toBe('event: message_start\ndata: {"type":"message_start","n":1}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    expect(parseSse(text)).toEqual(events);
    expect(parseSse('')).toEqual([]);
  });

  test('rejects text that is not event/data pairs', () => {
    expect(() => parseSse('data: {}\n\n')).toThrow('SSE block 1');
    expect(() => parseSse('event: x\ndata: {}')).toThrow('must end with a blank line');
  });
});
