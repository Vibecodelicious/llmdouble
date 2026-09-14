// Writer and reader agree: the real server records the prune conversation,
// `load` reads it back, and the assertions the fixture exists for hold. The
// checked-in fixture must match a fresh recording with the volatile fields
// masked, so the fixture cannot drift from the server; regenerate with
// `npm run fixtures`.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { load } from '../assert/load.js';
import { matchers } from '../assert/matchers.js';
import { maskVolatile, PRUNE_FIXTURE, PRUNE_SECRET, recordPruneFixture } from './prune.js';

expect.extend(matchers);

const dir = mkdtempSync(join(tmpdir(), 'llmdouble-fixture-'));

describe('the prune fixture', () => {
  test('the server records the conversation and load reads back what close() returned', async () => {
    const record = join(dir, 'fresh.jsonl');
    const fromClose = await recordPruneFixture(record);
    const fromLoad = load(record);
    expect(fromClose.count).toBe(3);
    expect(fromLoad.run).toEqual(fromClose.run);
    expect(fromLoad.summary).toEqual(fromClose.summary);
    expect(fromLoad.summary).toEqual({ scripted: 3, served: 3, repeated: 0, asides: 0, unmatched: 0, ambiguous: 0, invalid: 0, complete: true });
    expect(fromLoad.requests.map((r) => r.raw.body)).toEqual(fromClose.requests.map((r) => r.raw.body));
    expect(fromLoad.requests.map((r) => r.normalized)).toEqual(fromClose.requests.map((r) => r.normalized));
    expect([0, 1, 2].map((i) => fromLoad.servedBy(i).seq)).toEqual([1, 2, 3]);
    expect(fromLoad.request(1).messages.count).toBe(5);
    expect(fromLoad.request(2).messages.count).toBe(7);
    expect(fromLoad.last.messages.count).toBe(5);
    expect(fromLoad.last.messages.roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(fromLoad.request(2).contains(PRUNE_SECRET)).toPass();
    expect(fromLoad.last.doesNotContain(PRUNE_SECRET)).toPass();
    expect(fromLoad.last.system.contains('careful editor')).toPass();
    expect(fromLoad.last.responseBody).toContain('Four messages were archived');
  });

  test('the checked-in fixture matches a fresh recording once the volatile fields are masked', async () => {
    const record = join(dir, 'compare.jsonl');
    await recordPruneFixture(record);
    const fresh = maskVolatile(readFileSync(record, 'utf8'));
    const checkedIn = maskVolatile(readFileSync(PRUNE_FIXTURE, 'utf8'));
    expect(checkedIn, 'src/assert/fixtures/prune.jsonl differs from what the server records now; run `npm run fixtures`').toBe(fresh);
  });
});
