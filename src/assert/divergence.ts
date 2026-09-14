// Divergence (epic C4, P7; design §5.7): where two recordings' parsed raw
// bodies differ, as JSON paths of differing leaves, paired by array position.
//
// `onlyIn(selector)` is the anti-false-PASS mechanism: "differs somewhere" is
// nearly always true, so the verdict is PASS only when at least one difference
// exists and every difference lies inside the selector. Identical recordings
// FAIL with claim `recordings identical`.
//
// The diff runs over the parsed raw bodies, not the normalised views, so ids
// and every surface-native field count.

import type { Recording } from './recording.js';
import { BlockedError, fail, pass, type Verdict } from './verdict.js';

export interface DivergentRequest {
  /** The seq on this side, or on the other side for a request only it has. */
  seq: number;
  /** JSON paths of differing leaves; `["$"]` for an unpaired request. */
  paths: string[];
}

/** 1-based inclusive message range (0-based paths), or explicit path prefixes. */
export type OnlyInSelector = { messages: [from: number, to: number] } | { paths: string[] };

export class Divergence {
  readonly requests: DivergentRequest[];

  constructor(a: Recording, b: Recording) {
    const length = Math.max(a.count, b.count);
    this.requests = [];
    for (let i = 0; i < length; i += 1) {
      const left = a.requests[i];
      const right = b.requests[i];
      if (left === undefined || right === undefined) {
        this.requests.push({ seq: (left ?? right)!.seq, paths: ['$'] });
      } else {
        this.requests.push({ seq: left.seq, paths: diffBodies(left.raw.body, right.raw.body) });
      }
    }
  }

  /** True when every paired request is identical and no request is unpaired. */
  get isEmpty(): boolean {
    return this.requests.every((request) => request.paths.length === 0);
  }

  /**
   * PASS only when at least one difference exists and every difference is inside the selector.
   * `{ messages: [from, to] }` accepts paths under `$.messages[from-1]` .. `$.messages[to-1]`;
   * `{ paths }` accepts paths equal to a listed prefix or nested under it (`$.a` covers `$.a.b` and
   * `$.a[0]`, not `$.ab`). Differences outside are listed in `evidence.outside`.
   */
  onlyIn(selector: OnlyInSelector): Verdict {
    const prefixes = selectorPrefixes(selector);
    const claim = `recordings differ only in ${describeSelector(selector)}`;
    const all = this.requests.flatMap((request) => request.paths.map((path) => ({ seq: request.seq, path })));
    if (all.length === 0) return fail('recordings identical', { count: 0 });
    const outside = all.filter(({ path }) => !prefixes.some((prefix) => isUnder(path, prefix)));
    if (outside.length > 0) return fail(claim, { count: all.length, outside });
    return pass(claim, { count: all.length, inside: all });
  }
}

/** Path prefixes a selector accepts. Throws `BlockedError` on a malformed selector. */
export function selectorPrefixes(selector: OnlyInSelector): string[] {
  if ('messages' in selector) {
    const [from, to] = selector.messages;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      throw new BlockedError(`onlyIn messages selector must be [from, to] with 1 <= from <= to, got ${JSON.stringify(selector.messages)}`, {
        selector,
      });
    }
    return Array.from({ length: to - from + 1 }, (_, i) => `$.messages[${from - 1 + i}]`);
  }
  if (!Array.isArray(selector.paths) || selector.paths.length === 0 || selector.paths.some((p) => typeof p !== 'string' || p === '')) {
    throw new BlockedError(`onlyIn paths selector must be a non-empty array of paths, got ${JSON.stringify(selector.paths)}`, { selector });
  }
  return selector.paths;
}

function describeSelector(selector: OnlyInSelector): string {
  return 'messages' in selector ? `messages ${selector.messages[0]}..${selector.messages[1]}` : `paths ${selector.paths.join(', ')}`;
}

/** True when `path` equals `prefix` or continues it with `.` or `[`, so `$.a` covers `$.a.b`, not `$.ab`. */
export function isUnder(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  const next = path.charAt(prefix.length);
  return next === '' || next === '.' || next === '[';
}

/** Differing-leaf paths between two raw bodies. A body that is not JSON is compared as a whole string. */
export function diffBodies(a: string, b: string): string[] {
  const left = tryParse(a);
  const right = tryParse(b);
  if (left === null || right === null) return a === b ? [] : ['$'];
  return diffValues(left.value, right.value);
}

/**
 * Paths of every leaf at which `a` and `b` differ, `$`-rooted (`$.messages[1].content[0].text`). A key
 * present on one side only, an array element past the shorter length, and a node whose kinds differ are
 * each one path.
 */
export function diffValues(a: unknown, b: unknown, path = '$'): string[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: string[] = [];
    for (const key of keys) {
      const child = `${path}${keyAccessor(key)}`;
      if (!(key in a) || !(key in b)) out.push(child);
      else out.push(...diffValues(a[key], b[key], child));
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = [];
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i += 1) out.push(...diffValues(a[i], b[i], `${path}[${i}]`));
    for (let i = shared; i < Math.max(a.length, b.length); i += 1) out.push(`${path}[${i}]`);
    return out;
  }
  return a === b ? [] : [path];
}

function keyAccessor(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParse(text: string): { value: unknown } | null {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}
