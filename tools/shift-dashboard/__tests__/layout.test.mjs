// Tests for the Loop-layout additions: sidebar nav, right rail (attention +
// stream panels), and the cross-repo aggregators that feed them.
//
// Run: node --test tools/shift-dashboard/__tests__/layout.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectAcrossRepos,
  renderAttentionPanel,
  renderStreamPanel,
  renderRail,
  renderSidebar,
} from '../worker.js';

// ─── collectAcrossRepos ──────────────────────────────────────────────

test('collectAcrossRepos: flattens per-repo arrays with _repo + _shift tags', () => {
  const repos = [
    { repo: 'org/a', dayPrs: [{ number: 1 }, { number: 2 }] },
    { repo: 'org/b', dayPrs: [{ number: 3 }] },
  ];
  const flat = collectAcrossRepos(repos, 'dayPrs');
  assert.equal(flat.length, 3);
  assert.equal(flat[0].number, 1);
  assert.equal(flat[0]._repo, 'org/a');
  assert.equal(flat[0]._shift, 'day');
  assert.equal(flat[2]._repo, 'org/b');
});

test('collectAcrossRepos: infers night vs day shift from key prefix', () => {
  const repos = [{ repo: 'org/a', nightPrs: [{ number: 9 }] }];
  const flat = collectAcrossRepos(repos, 'nightPrs');
  assert.equal(flat[0]._shift, 'night');
});

test('collectAcrossRepos: error-shape fields skipped (no crash)', () => {
  const repos = [
    { repo: 'org/a', dayPrs: { error: 'boom' } },
    { repo: 'org/b', dayPrs: [{ number: 1 }] },
  ];
  const flat = collectAcrossRepos(repos, 'dayPrs');
  assert.equal(flat.length, 1);
  assert.equal(flat[0].number, 1);
});

// ─── renderAttentionPanel ────────────────────────────────────────────

test('renderAttentionPanel: empty when no needs-human PRs (hides panel)', () => {
  const html = renderAttentionPanel([{ repo: 'x', dayPrs: [{ number: 1, labels: ['enhancement'], title: 't', url: 'u' }] }], 'now');
  assert.equal(html, '');
});

test('renderAttentionPanel: renders needs-human PRs from any shift', () => {
  const html = renderAttentionPanel([
    {
      repo: 'org/example-app',
      dayPrs: [
        { number: 100, labels: ['enhancement'], title: 'ok', url: 'u1' },
        { number: 101, labels: ['day-shift:needs-human'], title: 'blocker A', url: 'u2' },
      ],
      nightPrs: [
        { number: 102, labels: ['night-shift:needs-human'], title: 'blocker B', url: 'u3' },
      ],
    },
  ], 'now');
  assert.ok(html.includes('id="attention"'));
  assert.ok(html.includes('#101'));
  assert.ok(html.includes('#102'));
  assert.ok(!html.includes('#100'), 'non-blocker PR must not appear in attention list');
  assert.ok(html.includes('example-app'));
  assert.ok(html.includes('blocker A'));
  assert.ok(html.includes('blocker B'));
});

test('renderAttentionPanel: caps at 8 with "+N more" overflow', () => {
  const dayPrs = Array.from({ length: 12 }, (_, i) => ({
    number: 200 + i,
    labels: ['day-shift:needs-human'],
    title: `blocker ${i}`,
    url: `u${i}`,
  }));
  const html = renderAttentionPanel([{ repo: 'x/y', dayPrs }], 'now');
  assert.ok(html.includes('+4 more'));
});

test('renderAttentionPanel: HTML-escapes titles (XSS defence)', () => {
  const html = renderAttentionPanel([{
    repo: 'x/y',
    dayPrs: [{ number: 1, labels: ['day-shift:needs-human'], title: '<script>alert(1)</script>', url: 'u' }],
  }], 'now');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

// ─── renderStreamPanel ───────────────────────────────────────────────

test('renderStreamPanel: idle state when no runs', () => {
  const html = renderStreamPanel([], 'now');
  assert.ok(html.includes('panel-stream'));
  assert.ok(html.includes('idle'));
  assert.ok(html.includes('No dispatch activity yet'));
});

test('renderStreamPanel: aggregates runs across repos + shifts, newest first', () => {
  const html = renderStreamPanel([
    {
      repo: 'org/a',
      dayRuns: [
        { runNumber: 1, createdAt: '2026-08-01T10:00:00Z', status: 'completed', conclusion: 'success', url: 'u1' },
        { runNumber: 2, createdAt: '2026-08-01T12:00:00Z', status: 'completed', conclusion: 'failure', url: 'u2' },
      ],
      nightRuns: [
        { runNumber: 3, createdAt: '2026-08-01T14:00:00Z', status: 'in_progress', conclusion: null, url: 'u3' },
      ],
    },
  ], '2026-08-01T15:00:00Z');
  // Newest first → run #3 (14:00), then #2 (12:00), then #1 (10:00)
  const idx1 = html.indexOf('#3');
  const idx2 = html.indexOf('#2');
  const idx3 = html.indexOf('#1');
  assert.ok(idx1 > 0 && idx2 > idx1 && idx3 > idx2, 'runs render newest-first');
});

test('renderStreamPanel: live status when any run is not completed', () => {
  const html = renderStreamPanel([{
    repo: 'x/y',
    dayRuns: [{ runNumber: 1, createdAt: '2026-08-01T10:00:00Z', status: 'in_progress', conclusion: null, url: 'u' }],
    nightRuns: [],
  }], '2026-08-01T11:00:00Z');
  assert.ok(html.match(/live/i));
});

// ─── renderRail ──────────────────────────────────────────────────────

test('renderRail: contains both attention (when present) and stream panels', () => {
  const html = renderRail([{
    repo: 'x/y',
    dayPrs: [{ number: 1, labels: ['day-shift:needs-human'], title: 't', url: 'u' }],
    nightPrs: [], dayMerged: [], nightMerged: [],
    dayRuns: [], nightRuns: [],
  }], 'now');
  assert.ok(html.includes('panel-attention'));
  assert.ok(html.includes('panel-stream'));
});

test('renderRail: only stream panel when nothing needs attention (attention hides)', () => {
  const html = renderRail([{
    repo: 'x/y',
    dayPrs: [], nightPrs: [], dayMerged: [], nightMerged: [],
    dayRuns: [], nightRuns: [],
  }], 'now');
  assert.ok(!html.includes('panel-attention'));
  assert.ok(html.includes('panel-stream'));
});

// ─── renderSidebar ───────────────────────────────────────────────────

test('renderSidebar: SHIFTS brand + WORKSPACE section + coming-soon section + user pill', () => {
  const html = renderSidebar([]);
  assert.ok(html.includes('SHIFTS'));
  assert.ok(html.includes('Workspace'));
  assert.ok(html.includes('Coming soon'));
  assert.ok(html.includes('side-user'));
});

test('renderSidebar: nav items link to page anchors', () => {
  const html = renderSidebar([]);
  assert.ok(html.includes('href="#top"'));
  assert.ok(html.includes('href="#ready"'));
  assert.ok(html.includes('href="#open"'));
  assert.ok(html.includes('href="#attention"'));
  assert.ok(html.includes('href="#history"'));
});

test('renderSidebar: shows live counts from aggregated data', () => {
  const html = renderSidebar([{
    repo: 'x/y',
    dayPrs: [{ number: 1, labels: [] }, { number: 2, labels: ['day-shift:needs-human'] }],
    nightPrs: [{ number: 3, labels: [] }],
    dayMerged: [{ number: 4 }],
    nightMerged: [],
  }]);
  // open = 3 (2 day + 1 night)
  // ready = 1 (1 day merged)
  // attention = 1 (needs-human labeled)
  assert.ok(html.includes('>3<'), 'open count');
  assert.ok(html.includes('>1<'), 'ready or attention count present');
});

test('renderSidebar: dashboard link marked active on default', () => {
  const html = renderSidebar([]);
  assert.ok(html.includes('side-item-active'));
});

test('renderSidebar: coming-soon items are non-links (disabled)', () => {
  const html = renderSidebar([]);
  // Agents/Deployments/Settings should not have href
  const agentsRegion = html.match(/Agents[\s\S]{0,200}/);
  assert.ok(agentsRegion);
  assert.ok(agentsRegion[0].includes('side-item-disabled') || agentsRegion[0].includes('soon'));
});

test('renderSidebar: portable - no hardcoded project name in nav', () => {
  const html = renderSidebar([{ repo: 'someone/other-project', dayPrs: [], nightPrs: [] }]);
  assert.ok(!html.includes('example-app'));
  assert.ok(!html.includes('your-org'));
});
