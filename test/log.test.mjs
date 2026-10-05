import test from 'node:test';
import assert from 'node:assert/strict';
import { describeError, redact, registerSecret } from '../scripts/lib/log.mjs';

test('registered secrets are redacted with or without 0x and in any case', () => {
  const key = `0x${'ab'.repeat(32)}`;
  registerSecret(key);
  assert.equal(redact(`k=${key}`), 'k=[REDACTED]');
  assert.equal(redact(`k=${key.slice(2).toUpperCase()}`), 'k=[REDACTED]');
  assert.ok(!redact({ nested: { key } }).includes('abab'));
  assert.ok(!describeError(new Error(`bad key ${key}`)).includes('abab'));
});
