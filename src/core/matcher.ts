// `when:` evaluation for asides (epic C2, design §4.1).
//
// Every field present must hold (AND). A field absent from the request that
// the matcher needs (a null maxTokens) does not match.

import { systemText, type NormalizedRequest } from './normalize.js';
import type { NumberMatcher, StringMatcher, When } from './scenario.js';

export function matchesWhen(when: When, request: NormalizedRequest): boolean {
  if (when.model !== undefined && !matchString(when.model, request.model)) return false;
  if (when.system !== undefined && !matchString(when.system, systemText(request))) return false;
  if (when.tools !== undefined) {
    if ('absent' in when.tools) {
      if ((request.tools.length === 0) !== when.tools.absent) return false;
    } else {
      const wanted = when.tools.includes;
      if (!request.tools.some((tool) => tool.name === wanted)) return false;
    }
  }
  if (when.messages !== undefined && !matchNumber(when.messages.count, request.messages.length)) return false;
  if (when.maxTokens !== undefined && !matchNumber(when.maxTokens, request.maxTokens)) return false;
  return true;
}

function matchString(matcher: StringMatcher, actual: string): boolean {
  if ('equals' in matcher) return actual === matcher.equals;
  if ('contains' in matcher) return actual.includes(matcher.contains);
  if ('startsWith' in matcher) return actual.startsWith(matcher.startsWith);
  return actual.endsWith(matcher.endsWith);
}

function matchNumber(matcher: NumberMatcher, actual: number | null): boolean {
  if (actual === null) return false;
  if ('equals' in matcher) return actual === matcher.equals;
  if ('lt' in matcher) return actual < matcher.lt;
  return actual > matcher.gt;
}
