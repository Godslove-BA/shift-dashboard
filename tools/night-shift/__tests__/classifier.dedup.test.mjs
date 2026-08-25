// Focused test for the classifier's cross-shift dedup gate.
// Reproduces the 2026-07-21 finding: tickets like #1143 had BOTH
// day-shift:review-2026-07-20 AND night-shift:dispatched-2026-07-20 labels,
// because each shift's classifier only knew about its own label prefix.
//
// Run with: node --test tools/night-shift/__tests__/classifier.dedup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIssue } from '../classifier.mjs';

function issueWith(labels, opts = {}) {
  return {
    number: opts.number ?? 1087,
    title: opts.title ?? 'feat(onboarding): brand-relevant stock images on the typeface page',
    // Body long enough to pass the vagueness gate.
    body: opts.body ?? 'The onboarding stock-image step currently pulls a generic Unsplash set. It should instead call the brand vertical detector and pull vertical-relevant photos. Acceptance: shows brand-relevant images when a vertical is detected. Files touched: src/features/onboarding/StepStockImages.tsx.',
    labels: labels.map((name) => ({ name })),
  };
}

test('rejects tickets already dispatched by night-shift (same-shift re-claim)', () => {
  const res = classifyIssue(issueWith([
    'enhancement',
    'night-shift:dispatched-2026-07-10',
  ]));
  assert.equal(res.verdict, 'in-progress');
  assert.match(res.reasons.join(' '), /night-shift:dispatched-2026-07-10/);
});

test('rejects tickets already dispatched by day-shift (cross-shift claim - the bug this fixes)', () => {
  const res = classifyIssue(issueWith([
    'enhancement',
    'day-shift:dispatched-2026-07-20',
  ]));
  assert.equal(res.verdict, 'in-progress');
  assert.match(res.reasons.join(' '), /day-shift:dispatched-2026-07-20/);
});

test('rejects tickets already reviewed by day-shift (day-shift:review-*)', () => {
  // #1143's actual state on 2026-07-20 (before night-shift also dispatched).
  const res = classifyIssue(issueWith([
    'enhancement',
    'day-shift:review-2026-07-20',
  ]));
  assert.equal(res.verdict, 'in-progress');
  assert.match(res.reasons.join(' '), /day-shift:review-2026-07-20/);
});

test('rejects tickets already labelled reviewed-clean (either shift)', () => {
  assert.equal(classifyIssue(issueWith(['day-shift:reviewed-clean'])).verdict, 'in-progress');
  assert.equal(classifyIssue(issueWith(['night-shift:reviewed-clean'])).verdict, 'in-progress');
});

test('rejects tickets flagged needs-human (either shift)', () => {
  assert.equal(classifyIssue(issueWith(['day-shift:needs-human'])).verdict, 'in-progress');
  assert.equal(classifyIssue(issueWith(['night-shift:needs-human'])).verdict, 'in-progress');
});

test('passes tickets with no shift claims and a substantive body', () => {
  const res = classifyIssue(issueWith(['enhancement']));
  assert.equal(res.verdict, 'safe');
});

test('still catches the old skip labels (ready-for-testing, wontfix, duplicate)', () => {
  assert.equal(classifyIssue(issueWith(['ready-for-testing'])).verdict, 'in-progress');
  assert.equal(classifyIssue(issueWith(['wontfix'])).verdict, 'in-progress');
  assert.equal(classifyIssue(issueWith(['duplicate'])).verdict, 'in-progress');
});

test('does NOT false-positive on unrelated labels starting with day-shift or night-shift', () => {
  // Hypothetical: a label like `night-shift:announce` or `day-shift:experimental` shouldn't block.
  // The regex is anchored on ':(dispatched-|review-|reviewed-clean|needs-human)' - anything else
  // in the ':x' slot is not a claim.
  const res = classifyIssue(issueWith(['enhancement', 'night-shift:announce', 'day-shift:experimental']));
  assert.equal(res.verdict, 'safe');
});
