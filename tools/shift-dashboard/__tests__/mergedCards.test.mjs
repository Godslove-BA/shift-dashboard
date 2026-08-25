// Unit tests for the dashboard v2 "merged-to-holding" cards + Next-actions
// strip + Test-locally / Promote recipe panels.
//
// Focus:
// - Recipes reference the PR's own base branch (portability across projects)
// - Next-actions strip aggregates correctly across repos + shifts
// - Recipes do NOT hardcode any user-specific or project-specific path
// - Error-shape fields don't crash the aggregators
//
// Run: node --test tools/shift-dashboard/__tests__/mergedCards.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeSum,
  renderNextActionsStrip,
  renderTestLocallyPanel,
  renderPromoteRecipe,
  renderMergedPr,
} from '../worker.js';

// Compact fixture builders so each case reads like a table row.
function pr(overrides = {}) {
  return {
    number: 1266,
    title: 'feat(business): Animate this flyer',
    url: 'https://github.com/your-org/your-repo/pull/1266',
    labels: [],
    mergedAt: '2026-07-30T23:19:00Z',
    updatedAt: '2026-07-30T23:19:00Z',
    base: 'day-shift-staging-2026-07-30',
    brain: null,
    ...overrides,
  };
}

test('safeSum: sums array field lengths across repos, ignores error shapes', () => {
  const repos = [
    { dayPrs: [{}, {}], nightPrs: [{}] },
    { dayPrs: { error: 'boom' }, nightPrs: [{}, {}, {}] },
    { dayPrs: [{}], nightPrs: [] },
  ];
  assert.equal(safeSum(repos, 'dayPrs'), 3);   // 2 + 0 (error) + 1
  assert.equal(safeSum(repos, 'nightPrs'), 4); // 1 + 3 + 0
});

test('safeSum: unknown key returns 0', () => {
  assert.equal(safeSum([{ dayPrs: [{}] }], 'missing'), 0);
});

test('renderNextActionsStrip: empty state renders "Nothing awaiting"', () => {
  const html = renderNextActionsStrip([]);
  assert.ok(html.includes('Nothing awaiting'));
});

test('renderNextActionsStrip: only-open state', () => {
  const html = renderNextActionsStrip([
    { dayPrs: [{}, {}], nightPrs: [{}], dayMerged: [], nightMerged: [] },
  ]);
  assert.ok(html.includes('3</span> awaiting your review'));
  assert.ok(!html.includes('ready to test'));
});

test('renderNextActionsStrip: only-merged state', () => {
  const html = renderNextActionsStrip([
    { dayPrs: [], nightPrs: [], dayMerged: [{}, {}], nightMerged: [] },
  ]);
  assert.ok(html.includes('2</span> ready to test locally or promote'));
  assert.ok(!html.includes('awaiting your review'));
});

test('renderNextActionsStrip: both states, joined with middot', () => {
  const html = renderNextActionsStrip([
    { dayPrs: [{}], nightPrs: [], dayMerged: [{}, {}], nightMerged: [] },
  ]);
  assert.ok(html.includes('1</span> awaiting your review'));
  assert.ok(html.includes('2</span> ready to test locally or promote'));
  assert.ok(html.includes('&middot;'));
});

test('renderTestLocallyPanel: recipe references PR base branch (portable across projects)', () => {
  const html = renderTestLocallyPanel(pr({ base: 'day-shift-staging-2026-07-30' }));
  assert.ok(html.includes('git fetch origin day-shift-staging-2026-07-30'));
  assert.ok(html.includes('git checkout day-shift-staging-2026-07-30'));
});

test('renderTestLocallyPanel: no hardcoded local paths (portability guard)', () => {
  const html = renderTestLocallyPanel(pr());
  assert.ok(!html.includes('/Users/'), 'must not hardcode any absolute local path');
  assert.ok(!html.includes('/home/'), 'must not hardcode any absolute local path');
  assert.ok(!html.includes('your-project'), 'must not hardcode a project-specific runtime worktree name');
});

test('renderTestLocallyPanel: works for a totally different holding branch (portability)', () => {
  const html = renderTestLocallyPanel(pr({ base: 'night-shift-staging-2027-01-15' }));
  assert.ok(html.includes('night-shift-staging-2027-01-15'));
  assert.ok(!html.includes('day-shift-staging'));
});

test('renderTestLocallyPanel: click-to-select affordance present', () => {
  const html = renderTestLocallyPanel(pr());
  // The user-select: all is in the CSS, but the pre.recipe class hook + "click"
  // hint must be present in the rendered markup.
  assert.ok(html.includes('class="recipe"'));
  assert.ok(html.match(/click.*to select/i));
});

test('renderTestLocallyPanel: mentions localhost open link', () => {
  const html = renderTestLocallyPanel(pr());
  assert.ok(html.includes('http://localhost:8080'));
});

test('renderPromoteRecipe: fast-forward merge into Staging + push', () => {
  const html = renderPromoteRecipe(pr({ base: 'day-shift-staging-2026-07-30' }));
  assert.ok(html.includes('git checkout Staging'));
  assert.ok(html.includes('git merge --no-ff origin/day-shift-staging-2026-07-30'));
  assert.ok(html.includes('git push origin Staging'));
});

test('renderPromoteRecipe: portable to any holding branch name', () => {
  const html = renderPromoteRecipe(pr({ base: 'night-shift-staging-2027-01-15' }));
  assert.ok(html.includes('git merge --no-ff origin/night-shift-staging-2027-01-15'));
});

test('renderMergedPr: renders both action panels + brain row (when brain present)', () => {
  const html = renderMergedPr(
    pr({
      brain: { schemaVersion: 1, ticketId: 1264, attempts: 1, lastOutcome: 'STUCK', lastDurationSec: 424, hints: 0, escalated: false },
    }),
    'day',
    '2026-07-30T23:30:00Z',
  );
  assert.ok(html.includes('merged to holding'));
  assert.ok(html.includes('Test locally'));
  assert.ok(html.includes('Promote holding to Staging'));
  assert.ok(html.includes('brain-row'));
  assert.ok(html.includes('#1266'));
});

test('renderMergedPr: no brain row when brain is null (older PRs)', () => {
  const html = renderMergedPr(pr({ brain: null }), 'day', '2026-07-30T23:30:00Z');
  assert.ok(!html.includes('brain-row'));
  // Action panels still render
  assert.ok(html.includes('Test locally'));
  assert.ok(html.includes('Promote holding to Staging'));
});

test('renderMergedPr: title is HTML-escaped (defence in depth)', () => {
  const html = renderMergedPr(pr({ title: '<script>alert(1)</script>' }), 'day', '2026-07-30T23:30:00Z');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
