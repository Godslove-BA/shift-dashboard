// Unit tests for tools/agent-brain/reader.mjs.
// Pure over the record argument - no fs. Fast + deterministic.
//
// Run: node --test tools/agent-brain/__tests__/reader.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAutoEscalated,
  escalationReason,
  getAttemptCount,
  getLastAttempt,
  getActiveHints,
  getAllKeyLearnings,
  countRecentOutcome,
} from '../reader.mjs';
import { emptyRecord } from '../schema.mjs';

function seed() {
  const r = emptyRecord(1, '2026-07-29T00:00:00.000Z');
  r.attempts.push(
    { id: 'a1', dispatched_at: '2026-07-29T00:00:00.000Z', shift: 'day', worker_id: 'w', branch: 'b', pr_url: null, outcome: 'STUCK', duration_sec: 60, key_learnings: ['x', 'y'] },
    { id: 'a2', dispatched_at: '2026-07-29T00:01:00.000Z', shift: 'night', worker_id: 'w', branch: 'b', pr_url: null, outcome: 'STUCK', duration_sec: 30, key_learnings: ['y', 'z'] },
    { id: 'a3', dispatched_at: '2026-07-29T00:02:00.000Z', shift: 'day', worker_id: 'w', branch: 'b', pr_url: null, outcome: 'COMPLETE', duration_sec: 90, key_learnings: ['done'] }
  );
  r.hints.push(
    { id: 'h1', text: 'read RLS docs', added_at: '2026-07-29T00:00:00.000Z', source: 'desk-review' },
    { id: 'h2', text: 'test timezone edge', added_at: '2026-07-29T00:00:01.000Z', source: 'human' }
  );
  return r;
}

test('isAutoEscalated: false by default', () => {
  const r = emptyRecord(1);
  assert.equal(isAutoEscalated(r), false);
});

test('isAutoEscalated: true when set + escalationReason returns the string', () => {
  const r = emptyRecord(1);
  r.escalation = { auto_escalate: true, reason: 'flapping', escalated_at: 't' };
  assert.equal(isAutoEscalated(r), true);
  assert.equal(escalationReason(r), 'flapping');
});

test('escalationReason: null when not escalated', () => {
  assert.equal(escalationReason(emptyRecord(1)), null);
});

test('getAttemptCount / getLastAttempt', () => {
  const r = seed();
  assert.equal(getAttemptCount(r), 3);
  assert.equal(getLastAttempt(r).id, 'a3');
});

test('getLastAttempt returns null for a fresh record', () => {
  assert.equal(getLastAttempt(emptyRecord(1)), null);
});

test('getActiveHints returns a shallow copy (mutating result does not corrupt record)', () => {
  const r = seed();
  const hints = getActiveHints(r);
  hints.pop();
  assert.equal(r.hints.length, 2);
});

test('getAllKeyLearnings: flatten + dedup + preserve chronological order', () => {
  const r = seed();
  assert.deepEqual(getAllKeyLearnings(r), ['x', 'y', 'z', 'done']);
});

test('getAllKeyLearnings: safe on records with no attempts', () => {
  assert.deepEqual(getAllKeyLearnings(emptyRecord(1)), []);
});

test('countRecentOutcome: counts across all attempts by default', () => {
  const r = seed();
  assert.equal(countRecentOutcome(r, 'STUCK'), 2);
  assert.equal(countRecentOutcome(r, 'COMPLETE'), 1);
  assert.equal(countRecentOutcome(r, 'MERGED'), 0);
});

test('countRecentOutcome: respects lookback window', () => {
  const r = seed();
  assert.equal(countRecentOutcome(r, 'STUCK', 1), 0);
  assert.equal(countRecentOutcome(r, 'STUCK', 2), 1);
  assert.equal(countRecentOutcome(r, 'STUCK', 3), 2);
});
