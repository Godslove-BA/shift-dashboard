// Unit tests for tools/agent-brain/schema.mjs.
//
// The schema module is pure data + two helpers. These tests pin the
// invariants downstream files rely on: SCHEMA_VERSION is a positive int,
// emptyRecord has the exact shape writers/readers assume, and
// canonicalHintText normalises whitespace + punctuation for dedup.
//
// Run: node --test tools/agent-brain/__tests__/schema.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, emptyRecord, canonicalHintText } from '../schema.mjs';

test('SCHEMA_VERSION is a positive integer', () => {
  assert.equal(typeof SCHEMA_VERSION, 'number');
  assert.ok(Number.isInteger(SCHEMA_VERSION));
  assert.ok(SCHEMA_VERSION > 0);
});

test('emptyRecord produces the exact shape callers assume', () => {
  const r = emptyRecord(42, '2026-07-29T00:00:00.000Z');
  assert.equal(r.schema_version, SCHEMA_VERSION);
  assert.equal(r.ticket_id, 42);
  assert.equal(r.created_at, '2026-07-29T00:00:00.000Z');
  assert.equal(r.updated_at, '2026-07-29T00:00:00.000Z');
  assert.deepEqual(r.attempts, []);
  assert.deepEqual(r.verdicts, []);
  assert.deepEqual(r.hints, []);
  assert.deepEqual(r.escalation, { auto_escalate: false, reason: null, escalated_at: null });
});

test('emptyRecord coerces ticket_id to number', () => {
  const r = emptyRecord('123', '2026-07-29T00:00:00.000Z');
  assert.equal(r.ticket_id, 123);
  assert.equal(typeof r.ticket_id, 'number');
});

test('canonicalHintText: lowercases + collapses whitespace + strips trailing punct', () => {
  assert.equal(canonicalHintText('Migration broke RLS.'), 'migration broke rls');
  assert.equal(canonicalHintText('migration  broke rls'), 'migration broke rls');
  assert.equal(canonicalHintText('  Migration BROKE Rls !  '), 'migration broke rls');
  assert.equal(canonicalHintText('one\ttwo\nthree'), 'one two three');
});

test('canonicalHintText: two spellings dedup to the same key', () => {
  const a = canonicalHintText('Missing timezone test.');
  const b = canonicalHintText('missing timezone test');
  assert.equal(a, b);
});

test('canonicalHintText: safe on null/undefined/non-string', () => {
  assert.equal(canonicalHintText(null), '');
  assert.equal(canonicalHintText(undefined), '');
  assert.equal(canonicalHintText(123), '123');
});
