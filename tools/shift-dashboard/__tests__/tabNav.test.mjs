// Unit tests for the sticky tab nav (Ready / Open / History).
//
// The tab nav is anchor-links to `#ready`, `#open`, `#history` - which map to
// the FIRST repo's matching sections (renderRepoSection stamps those IDs
// only when `isFirstRepo=true`, so IDs stay unique across the page).
//
// Run: node --test tools/shift-dashboard/__tests__/tabNav.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTabNav } from '../worker.js';

test('renderTabNav: three anchor tabs (ready first, then open, then history)', () => {
  const html = renderTabNav([]);
  // Order matters - ready first so the eye lands on the section the user
  // most commonly wants to reach quickly ("I merged something, take me there").
  const readyIdx = html.indexOf('href="#ready"');
  const openIdx = html.indexOf('href="#open"');
  const historyIdx = html.indexOf('href="#history"');
  assert.ok(readyIdx >= 0, 'ready tab present');
  assert.ok(openIdx >= 0, 'open tab present');
  assert.ok(historyIdx >= 0, 'history tab present');
  assert.ok(readyIdx < openIdx, 'ready tab renders before open tab');
  assert.ok(openIdx < historyIdx, 'open tab renders before history tab');
});

test('renderTabNav: shows counts pulled from aggregate', () => {
  const html = renderTabNav([
    { dayPrs: [{}, {}], nightPrs: [{}], dayMerged: [{}, {}, {}], nightMerged: [] },
    { dayPrs: [{}], nightPrs: [], dayMerged: [], nightMerged: [{}] },
  ]);
  // ready = 3 (day) + 1 (night) = 4;  open = 3 (day) + 1 (night) = 4
  assert.ok(html.includes('Ready to test / promote <span class="tab-count">(4)</span>'));
  assert.ok(html.includes('Open PRs <span class="tab-count">(4)</span>'));
});

test('renderTabNav: shows zero counts cleanly when nothing is present', () => {
  const html = renderTabNav([]);
  assert.ok(html.includes('(0)'));
  // No "NaN" or "undefined" leaks
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('undefined'));
});

test('renderTabNav: error-shape fields tolerated (do not throw or crash counts)', () => {
  const html = renderTabNav([
    { dayPrs: { error: 'boom' }, nightPrs: [{}], dayMerged: { error: 'boom' }, nightMerged: [{}, {}] },
  ]);
  // Errored arrays count as 0 - so open = 0 + 1 = 1, ready = 0 + 2 = 2
  assert.ok(html.includes('Ready to test / promote <span class="tab-count">(2)</span>'));
  assert.ok(html.includes('Open PRs <span class="tab-count">(1)</span>'));
});

test('renderTabNav: sticky class present (verifiable via CSS in worker.js)', () => {
  const html = renderTabNav([]);
  assert.ok(html.includes('class="tab-nav"'));
  assert.ok(html.includes('aria-label="Jump to section"'));
});

test('renderTabNav: no hardcoded project-specific labels (portability)', () => {
  const html = renderTabNav([{ dayPrs: [{}], dayMerged: [{}] }]);
  // Nav labels come from the repo list, not from hardcoded project names.
  // Add regressions here if a specific repo name ever slips into the render.
  assert.ok(!html.includes('your-org'));
});
