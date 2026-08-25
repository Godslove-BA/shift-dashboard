// Unit tests for tools/agent-brain/writer.mjs.
//
// Uses a tmp brain root per test. Uses an injectable `nowFn` for
// deterministic timestamps + ids. Focus areas:
// - recordAttempt appends + updates updated_at
// - recordVerdict appends
// - addHint dedupes by canonical text (returns {added:false} for dupes)
// - escalate is idempotent (re-escalate keeps original escalated_at)
// - clearEscalation resets everything to the empty escalation shape
//
// Run: node --test tools/agent-brain/__tests__/writer.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  recordAttempt,
  recordVerdict,
  addHint,
  escalate,
  clearEscalation,
} from '../writer.mjs';
import { readRecord } from '../storage-json.mjs';

async function makeTmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agent-brain-writer-test-'));
}

// Deterministic `now` factory so ids/timestamps in tests don't depend on wall clock.
function fakeNow(seed) {
  let counter = 0;
  return () => {
    counter += 1;
    return `2026-07-29T00:00:${String(counter).padStart(2, '0')}.${seed}Z`;
  };
}

test('recordAttempt appends + persists', async () => {
  const root = await makeTmpRoot();
  const now = fakeNow('111');
  await recordAttempt(
    root,
    1,
    {
      shift: 'day',
      worker_id: 'w1',
      branch: 'dayshift/1-x',
      pr_url: 'https://gh/pr/1',
      outcome: 'COMPLETE',
      duration_sec: 90,
      files_touched: ['a.ts'],
      key_learnings: ['fix was in b.ts'],
    },
    now
  );
  const rec = await readRecord(root, 1);
  assert.equal(rec.attempts.length, 1);
  const a = rec.attempts[0];
  assert.equal(a.shift, 'day');
  assert.equal(a.outcome, 'COMPLETE');
  assert.equal(a.branch, 'dayshift/1-x');
  assert.equal(a.pr_url, 'https://gh/pr/1');
  assert.equal(a.duration_sec, 90);
  assert.deepEqual(a.files_touched, ['a.ts']);
  assert.deepEqual(a.key_learnings, ['fix was in b.ts']);
  assert.ok(a.id.startsWith('attempt-'));
});

test('recordAttempt: multiple appends are chronological', async () => {
  const root = await makeTmpRoot();
  const now = fakeNow('222');
  await recordAttempt(root, 2, { shift: 'day', worker_id: 'w', branch: 'b', outcome: 'STUCK', duration_sec: 1 }, now);
  await recordAttempt(root, 2, { shift: 'night', worker_id: 'w', branch: 'b', outcome: 'STUCK', duration_sec: 2 }, now);
  const rec = await readRecord(root, 2);
  assert.equal(rec.attempts.length, 2);
  assert.equal(rec.attempts[0].shift, 'day');
  assert.equal(rec.attempts[1].shift, 'night');
});

test('recordAttempt: missing outcome throws', async () => {
  const root = await makeTmpRoot();
  await assert.rejects(() => recordAttempt(root, 3, { shift: 'day' }));
});

test('recordVerdict appends + persists', async () => {
  const root = await makeTmpRoot();
  const now = fakeNow('333');
  await recordVerdict(root, 4, { reviewer: 'desk-review', verdict: 'MINOR', pr_url: 'https://gh/pr/4', notes: 'nit' }, now);
  const rec = await readRecord(root, 4);
  assert.equal(rec.verdicts.length, 1);
  assert.equal(rec.verdicts[0].verdict, 'MINOR');
  assert.equal(rec.verdicts[0].reviewer, 'desk-review');
});

test('addHint: first hint is added', async () => {
  const root = await makeTmpRoot();
  const now = fakeNow('444');
  const res = await addHint(root, 5, 'Watch RLS on migration.', 'desk-review', now);
  assert.equal(res.added, true);
  assert.equal(res.hint.text, 'Watch RLS on migration.');
  assert.equal(res.hint.source, 'desk-review');
});

test('addHint: duplicate (case + whitespace + punct differ) is rejected', async () => {
  const root = await makeTmpRoot();
  const now = fakeNow('555');
  await addHint(root, 6, 'Missing timezone test.', 'desk-review', now);
  const second = await addHint(root, 6, '  missing timezone test  ', 'human', now);
  assert.equal(second.added, false);
  assert.equal(second.hint, null);
  const rec = await readRecord(root, 6);
  assert.equal(rec.hints.length, 1);
});

test('addHint: empty text throws', async () => {
  const root = await makeTmpRoot();
  await assert.rejects(() => addHint(root, 7, '   ', 'desk-review'));
});

test('addHint: text longer than 240 chars throws', async () => {
  const root = await makeTmpRoot();
  await assert.rejects(() => addHint(root, 8, 'a'.repeat(241), 'desk-review'));
});

test('escalate: sets auto_escalate + records reason + timestamp', async () => {
  const root = await makeTmpRoot();
  const now = fakeNow('666');
  await escalate(root, 9, 'bounced 3 times', now);
  const rec = await readRecord(root, 9);
  assert.equal(rec.escalation.auto_escalate, true);
  assert.equal(rec.escalation.reason, 'bounced 3 times');
  assert.ok(rec.escalation.escalated_at);
});

test('escalate: re-escalating with a new reason keeps original escalated_at', async () => {
  const root = await makeTmpRoot();
  const now = fakeNow('777');
  await escalate(root, 10, 'first', now);
  const first = await readRecord(root, 10);
  const originalTs = first.escalation.escalated_at;
  await escalate(root, 10, 'second', now);
  const second = await readRecord(root, 10);
  assert.equal(second.escalation.reason, 'second');
  assert.equal(second.escalation.escalated_at, originalTs);
});

test('clearEscalation resets to the empty shape', async () => {
  const root = await makeTmpRoot();
  const now = fakeNow('888');
  await escalate(root, 11, 'nope', now);
  await clearEscalation(root, 11, now);
  const rec = await readRecord(root, 11);
  assert.deepEqual(rec.escalation, { auto_escalate: false, reason: null, escalated_at: null });
});
