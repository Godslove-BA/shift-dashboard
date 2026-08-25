// Unit tests for tools/agent-brain/summarize.mjs.
// The summarizer builds the system-prompt injection block. Guarantees:
// - Empty in → empty out (caller can then skip the section entirely).
// - Last-attempt block includes outcome + duration + shift.
// - Hints listed with source annotation.
// - Long lines get clipped.
// - Line count bounded (MAX_LEARNINGS / MAX_HINTS respected).
//
// Run: node --test tools/agent-brain/__tests__/summarize.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeForPrompt } from '../summarize.mjs';
import { emptyRecord } from '../schema.mjs';

test('empty record → empty string', () => {
  assert.equal(summarizeForPrompt(emptyRecord(1)), '');
});

test('null / undefined → empty string (never throws)', () => {
  assert.equal(summarizeForPrompt(null), '');
  assert.equal(summarizeForPrompt(undefined), '');
});

test('record with only hints (no attempts) renders + tells the worker to act on hints', () => {
  const r = emptyRecord(7);
  r.hints.push({ id: 'h1', text: 'watch RLS on migration', added_at: 't', source: 'desk-review' });
  const out = summarizeForPrompt(r);
  assert.ok(out.includes('ticket #7'));
  assert.ok(out.includes('Hints for THIS attempt'));
  assert.ok(out.includes('watch RLS on migration'));
  assert.ok(out.includes('_(desk-review)_'));
});

test('renders last attempt outcome + duration + shift', () => {
  const r = emptyRecord(9);
  r.attempts.push({
    id: 'a1',
    dispatched_at: 't',
    shift: 'day',
    worker_id: 'w',
    branch: 'dayshift/9-x',
    pr_url: 'https://gh/pr/9',
    outcome: 'STUCK',
    duration_sec: 1500,
    error_summary: 'ran out of time',
    files_touched: ['a.ts', 'b.ts'],
    key_learnings: ['reproduces without auth'],
  });
  const out = summarizeForPrompt(r);
  assert.ok(out.includes('Last attempt: STUCK'));
  assert.ok(out.includes('25m'));
  assert.ok(out.includes('day-shift'));
  assert.ok(out.includes('ran out of time'));
  assert.ok(out.includes('dayshift/9-x'));
  assert.ok(out.includes('https://gh/pr/9'));
  assert.ok(out.includes('a.ts'));
  assert.ok(out.includes('reproduces without auth'));
});

test('clips lines longer than 240 chars', () => {
  const r = emptyRecord(11);
  const long = 'x'.repeat(500);
  r.hints.push({ id: 'h1', text: long, added_at: 't', source: 'human' });
  const out = summarizeForPrompt(r);
  // The rendered line should contain an ellipsis and not the full 500 xs verbatim.
  assert.ok(out.includes('…'));
  assert.ok(!out.includes('x'.repeat(300)));
});

test('renders "+N more" tail when more than MAX_HINTS hints present', () => {
  const r = emptyRecord(13);
  for (let i = 0; i < 12; i += 1) {
    r.hints.push({ id: `h${i}`, text: `hint number ${i}`, added_at: 't', source: 'human' });
  }
  const out = summarizeForPrompt(r);
  assert.ok(/…and \d+ more\.?/.test(out));
});

test('bounded output: never larger than ~4KB for a well-formed record', () => {
  const r = emptyRecord(15);
  for (let i = 0; i < 20; i += 1) {
    r.attempts.push({
      id: `a${i}`,
      dispatched_at: 't',
      shift: 'day',
      worker_id: 'w',
      branch: 'b',
      pr_url: null,
      outcome: 'STUCK',
      duration_sec: 60,
      key_learnings: [`learning ${i}`],
    });
    r.hints.push({ id: `h${i}`, text: `hint ${i}`, added_at: 't', source: 'human' });
  }
  const out = summarizeForPrompt(r);
  // With MAX_LEARNINGS=6 + MAX_HINTS=8 + one last-attempt block, the block
  // stays comfortably under 4KB (system-prompt budget concern).
  assert.ok(out.length < 4096, `expected <4KB, got ${out.length}`);
});
