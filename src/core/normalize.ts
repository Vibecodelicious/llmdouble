// The surface-neutral view of a request (epic C3 `normalized`).
//
// Each surface's parser produces a NormalizedRequest; the matcher, the
// terminal view, and story 2's assertion library read only this shape plus
// the raw body. Messages mirror the wire array one-to-one and in order; the
// normaliser reduces blocks but never drops, merges, or reorders messages.

export type NormalizedBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; text: string };

export interface NormalizedMessage {
  role: string;
  content: NormalizedBlock[];
}

export interface NormalizedRequest {
  model: string;
  stream: boolean;
  maxTokens: number | null;
  system: Array<{ text: string }>;
  messages: NormalizedMessage[];
  tools: Array<{ name: string }>;
}

/** Reduce a block the surface does not model (image, thinking, ...) to a text block holding its JSON. */
export function opaqueBlock(raw: unknown): NormalizedBlock {
  return { type: 'text', text: JSON.stringify(raw) ?? '' };
}

/** What one block contributes to its message's text (C3): text, the tool input as JSON, or the tool result text. */
export function blockText(block: NormalizedBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'tool_use':
      return JSON.stringify(block.input) ?? '';
    case 'tool_result':
      return block.text;
  }
}

/** A message's normalised text: every block's text concatenated in order, so no block is invisible to a predicate. */
export function messageText(message: NormalizedMessage): string {
  return message.content.map(blockText).join('');
}

/** The system text the `when.system` matcher reads: every system block's text, newline-joined. */
export function systemText(request: NormalizedRequest): string {
  return request.system.map((block) => block.text).join('\n');
}
