// Behavior tests for tools/day-shift/factory-router.mjs — the Factory
// Router classifier that routes each safe ticket to a per-work-type
// pipeline (ADW pattern).
//
// WHY these tests: the classifier is deterministic and pure, but it's
// deciding which recipe (wall clock, prompt augment, guard rails) a
// ticket runs under. A quiet misclassification (e.g. a `docs:` ticket
// routed to `feature`) would burn 25 min of Max quota for what should
// have been 10 min. So we pin the precedence and the edge cases here,
// where they're cheap to catch.
//
// Run: node --test tools/day-shift/__tests__/factory-router.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, describeClassification, WORK_TYPES } from '../factory-router.mjs';

// Small helper so each test case reads like a table row: fake issue → verdict.
function issue({ title = '', labels = [], body = '', number = 1 } = {}) {
  return { number, title, body, labels };
}

test('title-prefix hotfix → hotfix', () => {
  const v = classify(issue({ title: 'hotfix: bounce back the CTA when stripe returns 402' }));
  assert.equal(v.workType, 'hotfix');
  assert.equal(v.matched.source, 'title');
});

test('title-prefix feat → feature', () => {
  const v = classify(issue({ title: 'feat(business): add pricing tier picker to calendar' }));
  assert.equal(v.workType, 'feature');
  assert.equal(v.matched.source, 'title');
});

test('title-prefix feature (long form) → feature', () => {
  const v = classify(issue({ title: 'feature: new avatar gallery' }));
  assert.equal(v.workType, 'feature');
});

test('title-prefix fix → bug', () => {
  const v = classify(issue({ title: 'fix(cinematic): grid crashes on empty scene list' }));
  assert.equal(v.workType, 'bug');
  assert.equal(v.matched.source, 'title');
});

test('title-prefix chore → chore', () => {
  const v = classify(issue({ title: 'chore: bump prettier config' }));
  assert.equal(v.workType, 'chore');
});

test('title-prefix docs → chore (documentation lives on the chore track)', () => {
  const v = classify(issue({ title: 'docs: clarify LLM gateway rule in CLAUDE.md' }));
  assert.equal(v.workType, 'chore');
});

test('title-prefix test → chore', () => {
  const v = classify(issue({ title: 'test: pin regression for #1200' }));
  assert.equal(v.workType, 'chore');
});

test('label-only hotfix → hotfix (title has no prefix)', () => {
  const v = classify(issue({
    title: 'CTA is dead when stripe returns 402',
    labels: [{ name: 'hotfix' }],
  }));
  assert.equal(v.workType, 'hotfix');
  assert.equal(v.matched.source, 'label');
});

test('label-only p0 → hotfix', () => {
  const v = classify(issue({ title: 'checkout blank on Safari', labels: ['p0'] }));
  assert.equal(v.workType, 'hotfix');
});

test('label-only urgent → hotfix', () => {
  const v = classify(issue({ title: 'onboarding stuck for new users', labels: ['urgent'] }));
  assert.equal(v.workType, 'hotfix');
});

test('label-only enhancement → feature', () => {
  const v = classify(issue({ title: 'add copy button', labels: ['enhancement'] }));
  assert.equal(v.workType, 'feature');
});

test('label-only bug → bug', () => {
  const v = classify(issue({ title: 'wrong colour on chip', labels: ['bug'] }));
  assert.equal(v.workType, 'bug');
});

test('label-only chore → chore', () => {
  const v = classify(issue({ title: 'sweep dead imports', labels: ['chore'] }));
  assert.equal(v.workType, 'chore');
});

test('label-only documentation → chore', () => {
  const v = classify(issue({ title: 'update README', labels: ['documentation'] }));
  assert.equal(v.workType, 'chore');
});

test('unknown when title has no prefix AND no relevant label', () => {
  const v = classify(issue({ title: 'thoughts on the next iteration', labels: ['discussion'] }));
  assert.equal(v.workType, 'unknown');
  assert.equal(v.matched.source, 'default');
});

test('title precedence beats label — hotfix title with feature label → hotfix', () => {
  const v = classify(issue({
    title: 'hotfix: rollback the tier picker crash',
    labels: [{ name: 'enhancement' }],
  }));
  assert.equal(v.workType, 'hotfix');
  assert.equal(v.matched.source, 'title');
});

test('hotfix label wins over bug label (mixed labels, no title prefix)', () => {
  const v = classify(issue({
    title: 'checkout is 402ing',
    labels: [{ name: 'bug' }, { name: 'hotfix' }],
  }));
  assert.equal(v.workType, 'hotfix');
});

test('feature label wins over bug label (mixed labels, no title prefix)', () => {
  // A ticket the triager saw as a feature that also fixes a shortcoming
  // should route to feature, not bug — matches how a human would treat it.
  const v = classify(issue({
    title: 'add error toast when publish fails',
    labels: [{ name: 'bug' }, { name: 'enhancement' }],
  }));
  assert.equal(v.workType, 'feature');
});

test('empty issue (no title, no labels, no body) → unknown, does not throw', () => {
  const v = classify({});
  assert.equal(v.workType, 'unknown');
  assert.equal(v.matched.source, 'default');
});

test('null-ish input does not throw (defensive)', () => {
  // The dispatcher shouldn't ever hand us null, but defensive coding here
  // costs one line and prevents a crashed run.
  const v = classify(null);
  assert.equal(v.workType, 'unknown');
});

test('missing labels array is treated as no labels', () => {
  const v = classify(issue({ title: 'random title without prefix' }));
  assert.equal(v.workType, 'unknown');
});

test('label matching is case-insensitive', () => {
  const v = classify(issue({ title: 'no prefix', labels: [{ name: 'HotFix' }] }));
  assert.equal(v.workType, 'hotfix');
});

test('label with whitespace `p 0` is normalised to `p-0` → hotfix', () => {
  const v = classify(issue({ title: 'no prefix', labels: [{ name: 'p 0' }] }));
  assert.equal(v.workType, 'hotfix');
});

test('bugfix long-form title → bug', () => {
  const v = classify(issue({ title: 'bugfix: dropdown misalignment' }));
  assert.equal(v.workType, 'bug');
});

test('refactor: title → chore', () => {
  const v = classify(issue({ title: 'refactor: split ChatInterface header out' }));
  assert.equal(v.workType, 'chore');
});

test('scope-annotated title still classifies (e.g. `feat(scope):`)', () => {
  const v = classify(issue({ title: 'feat(business-flyer): add mobile preview' }));
  assert.equal(v.workType, 'feature');
});

test('leading bracketed marker tolerated (e.g. `[URGENT] fix: …`)', () => {
  const v = classify(issue({ title: '[URGENT] fix: crash on empty selection' }));
  assert.equal(v.workType, 'bug');
});

test('describeClassification returns a short log-friendly string', () => {
  const s = describeClassification(issue({ number: 42, title: 'hotfix: whatever' }));
  assert.match(s, /^#42 → hotfix \(title:/);
});

test('WORK_TYPES export includes all four + unknown', () => {
  assert.deepEqual([...WORK_TYPES].sort(), ['bug', 'chore', 'feature', 'hotfix', 'unknown']);
});

test('title body is truncated in matched.value so logs stay short', () => {
  const longTitle = 'feat: ' + 'a'.repeat(200);
  const v = classify(issue({ title: longTitle }));
  assert.equal(v.workType, 'feature');
  assert.ok(v.matched.value.length <= 80, `matched.value length ${v.matched.value.length} > 80`);
});

test('a completely off-shape label list does not match by default', () => {
  const v = classify(issue({ title: 'title with no prefix', labels: [{ name: 'triage' }, { name: 'needs-info' }] }));
  assert.equal(v.workType, 'unknown');
});
