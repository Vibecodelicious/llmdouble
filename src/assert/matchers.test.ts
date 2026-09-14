import { describe, expect, test } from 'vitest';
import { matchers } from './matchers.js';
import { recording } from './testing.js';
import { blocked, fail, pass } from './verdict.js';

expect.extend(matchers);

describe('toPass', () => {
  test('PASS passes', () => {
    expect(pass('ok')).toPass();
    expect(recording([{ messages: [{ role: 'user', content: 'clean' }] }]).last.doesNotContain('SECRET')).toPass();
  });

  test('FAIL fails with the claim and evidence in the message', () => {
    expect(() => expect(fail('request 3 does not contain "SECRET"', { seq: 3, offset: 41 })).toPass()).toThrow(
      /FAIL: request 3 does not contain "SECRET"\nevidence: \{"seq":3,"offset":41\}/,
    );
  });

  test('BLOCKED fails with a message beginning BLOCKED:', () => {
    expect(() => expect(blocked('the recording has no requests', { count: 0 })).toPass()).toThrow(/^BLOCKED: the recording has no requests\nevidence: \{"count":0\}/);
    expect(() => expect(recording([]).every.doesNotContain('SECRET')).toPass()).toThrow(/^BLOCKED: cannot evaluate every request does not contain "SECRET"/);
  });

  test('BLOCKED cannot be mistaken for PASS: it fails under .not as well', () => {
    expect(() => expect(blocked('nothing to evaluate')).not.toPass()).toThrow(/^BLOCKED: nothing to evaluate/);
    expect(fail('x')).not.toPass();
    expect(() => expect(pass('x')).not.toPass()).toThrow(/expected the verdict not to pass/);
  });

  test('a non-verdict fails rather than passing', () => {
    expect(() => expect(undefined).toPass()).toThrow(/expected a Verdict/);
    expect(() => expect(true).toPass()).toThrow(/expected a Verdict/);
    expect(() => expect({ status: 'PASS' }).toPass()).toThrow(/expected a Verdict/);
  });

  test('the matcher speaks the shared expect.extend protocol: { pass, message } with isNot on this', () => {
    const plain = matchers.toPass.call({ isNot: false }, pass('ok'));
    expect(plain.pass).toBe(true);
    expect(typeof plain.message()).toBe('string');
    expect(matchers.toPass.call({ isNot: false }, blocked('b')).pass).toBe(false);
    expect(matchers.toPass.call({ isNot: true }, blocked('b')).pass).toBe(true);
    expect(matchers.toPass.call(undefined, blocked('b')).pass).toBe(false);
    expect(matchers.toPass.call(undefined, fail('f')).pass).toBe(false);
  });
});
