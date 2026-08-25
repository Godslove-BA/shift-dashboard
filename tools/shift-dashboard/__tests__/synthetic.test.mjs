// SYNTHETIC_PRS mode returns a stable fixture so the OSS repo is runnable
// without a GitHub token. If this test fails, `SYNTHETIC_PRS=1 wrangler dev`
// is about to break — fix the fixture, not the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticShiftState, renderHtml } from '../worker.js';

test('syntheticShiftState: returns loadShiftState-shaped object', () => {
  const s = syntheticShiftState();
  assert.equal(typeof s.now, 'string');
  assert.ok(Array.isArray(s.repos));
  assert.ok(s.repos.length >= 1);
  const r = s.repos[0];
  for (const k of ['repo', 'dayPrs', 'nightPrs', 'nightRuns', 'dayRuns', 'dayMerged', 'nightMerged', 'nightCron', 'permissions']) {
    assert.ok(k in r, `repo missing key ${k}`);
  }
});

test('syntheticShiftState: PRs cover every freshness bucket + at least one no-op + one needs-human', () => {
  const s = syntheticShiftState();
  const now = new Date(s.now).getTime();
  const HOUR = 3600 * 1000;
  const ages = s.repos[0].dayPrs.map(pr => (now - new Date(pr.updatedAt).getTime()) / HOUR);
  assert.ok(ages.some(h => h < 14), 'need at least one PR in the "fresh" bucket');
  assert.ok(ages.some(h => h >= 14 && h < 38), 'need at least one PR in "yesterday"');
  assert.ok(ages.some(h => h >= 38 && h < 24 * 7), 'need at least one PR in "this week"');
  assert.ok(ages.some(h => h >= 24 * 7), 'need at least one PR in "older"');
  const noOps = s.repos[0].dayPrs.filter(pr => pr.changed_files === 1 && (pr.additions + pr.deletions) === 0);
  assert.ok(noOps.length >= 1, 'need at least one no-op PR to demo the no-op section');
  const needsHuman = s.repos[0].dayPrs.filter(pr => pr.labels.includes('day-shift:needs-human'));
  assert.ok(needsHuman.length >= 1, 'need at least one needs-human PR to demo the attention panel');
});

test('syntheticShiftState: renders end-to-end via renderHtml without throwing', () => {
  const s = syntheticShiftState();
  const html = renderHtml(s, { theme: 'dark', requestUrl: new URL('https://example.workers.dev/'), flash: null });
  assert.ok(html.startsWith('<!doctype html>') || html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('Shift dashboard'));
  // Fixture PRs should surface in the render.
  assert.ok(html.includes('#1284'));
});
