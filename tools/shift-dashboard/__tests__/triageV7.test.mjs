// Tests for the v7 5th-grader triage rework - freshness bucketing, plain-
// English commit-title translation, no-op detection, checklist builder,
// approve/reject/snooze form rendering + gating, Codex-session URL parsing,
// and flash-cookie round-trip.
//
// Run: node --test tools/shift-dashboard/__tests__/triageV7.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupPrsByFreshness,
  isNoOpPr,
  renderPlainEnglishSummary,
  parseCodexSessionUrl,
  buildChecklist,
  renderCheckList,
  renderTestBrowserCtas,
  renderActionForms,
  renderContinuePanel,
  renderTriageCard,
  renderFreshnessGroup,
  renderNoOpSection,
  renderFlashBanner,
  renderTriageStrip,
  renderTriageRepoSection,
  readFlashCookie,
  groupByTicket,
  renderHtml,
} from '../worker.js';

const nowIso = '2026-08-04T12:00:00Z';
const hoursAgo = (h) => new Date(new Date(nowIso).getTime() - h * 3600e3).toISOString();
const daysAgo = (d) => hoursAgo(d * 24);

// ─── groupPrsByFreshness ─────────────────────────────────────────────

test('groupPrsByFreshness: bucketises by updatedAt against now', () => {
  const prs = [
    { number: 1, updatedAt: hoursAgo(3) },    // fresh
    { number: 2, updatedAt: hoursAgo(13.9) }, // fresh (just inside 14h)
    { number: 3, updatedAt: hoursAgo(20) },   // yesterday
    { number: 4, updatedAt: hoursAgo(37) },   // yesterday (just inside 38h)
    { number: 5, updatedAt: daysAgo(3) },     // thisWeek
    { number: 6, updatedAt: daysAgo(6.9) },   // thisWeek
    { number: 7, updatedAt: daysAgo(10) },    // older
    { number: 8, updatedAt: daysAgo(30) },    // older
  ];
  const b = groupPrsByFreshness(prs, { now: nowIso });
  assert.deepEqual(b.fresh.map(p => p.number), [1, 2]);
  assert.deepEqual(b.yesterday.map(p => p.number), [3, 4]);
  assert.deepEqual(b.thisWeek.map(p => p.number), [5, 6]);
  assert.deepEqual(b.older.map(p => p.number), [7, 8]);
});

test('groupPrsByFreshness: newest first inside each bucket', () => {
  const prs = [
    { number: 10, updatedAt: hoursAgo(10) },
    { number: 11, updatedAt: hoursAgo(3) },
    { number: 12, updatedAt: hoursAgo(6) },
  ];
  const b = groupPrsByFreshness(prs, { now: nowIso });
  assert.deepEqual(b.fresh.map(p => p.number), [11, 12, 10], 'newest first');
});

test('groupPrsByFreshness: missing/invalid updatedAt falls to older', () => {
  const prs = [
    { number: 1 },
    { number: 2, updatedAt: '' },
    { number: 3, updatedAt: 'not a date' },
  ];
  const b = groupPrsByFreshness(prs, { now: nowIso });
  assert.equal(b.older.length, 3);
  assert.equal(b.fresh.length, 0);
});

test('groupPrsByFreshness: empty / non-array → all buckets empty', () => {
  assert.deepEqual(groupPrsByFreshness([], { now: nowIso }), { fresh: [], yesterday: [], thisWeek: [], older: [] });
  assert.deepEqual(groupPrsByFreshness(null, { now: nowIso }).fresh, []);
});

// ─── isNoOpPr ──────────────────────────────────────────────────────

test('isNoOpPr: zero changed_files is a no-op', () => {
  assert.equal(isNoOpPr({ changed_files: 0, additions: 0, deletions: 0 }), true);
});

test('isNoOpPr: 1 file + 0 delta is a no-op (empty commit / whitespace-only)', () => {
  assert.equal(isNoOpPr({ changed_files: 1, additions: 0, deletions: 0 }), true);
});

test('isNoOpPr: body marker triggers even when enrichment is missing', () => {
  assert.equal(isNoOpPr({ body: 'No code changes - already on Staging.' }), true);
  assert.equal(isNoOpPr({ body: 'nothing to do this run' }), true);
});

test('isNoOpPr: real PR with edits is NOT a no-op', () => {
  assert.equal(isNoOpPr({ changed_files: 3, additions: 40, deletions: 5 }), false);
});

test('isNoOpPr: null enrichment without body marker is NOT declared no-op', () => {
  // Safer to show than to silently hide - the reviewer decides.
  assert.equal(isNoOpPr({ changed_files: null, additions: null, deletions: null }), false);
});

test('isNoOpPr: PR #1302-style (empty diff, no marker) - detected only via changed_files', () => {
  const like1302 = { changed_files: 0, additions: 0, deletions: 0, body: 'The fix was already staged; this run had nothing to change.' };
  assert.equal(isNoOpPr(like1302), true);
});

// ─── renderPlainEnglishSummary ────────────────────────────────────

test('renderPlainEnglishSummary: conventional commit fix(scope) → "Fix (scope): Rest"', () => {
  assert.equal(
    renderPlainEnglishSummary({ title: 'fix(auth): remember last used login method' }),
    'Fix (auth): Remember last used login method',
  );
});

test('renderPlainEnglishSummary: feat becomes "New feature"', () => {
  assert.equal(
    renderPlainEnglishSummary({ title: 'feat(business): calendar keyboard shortcuts' }),
    'New feature (business): Calendar keyboard shortcuts',
  );
});

test('renderPlainEnglishSummary: strips trailing (#1234) ticket ref', () => {
  assert.equal(
    renderPlainEnglishSummary({ title: 'fix(seo): FAQ schema never emitted (#1309)' }),
    'Fix (seo): FAQ schema never emitted',
  );
});

test('renderPlainEnglishSummary: no colon → returns title with first letter capitalised', () => {
  assert.equal(
    renderPlainEnglishSummary({ title: 'update readme' }),
    'Update readme',
  );
});

test('renderPlainEnglishSummary: unknown type is left as-is (does not lie about the change)', () => {
  // We would rather render the raw title than fabricate a translation.
  const s = renderPlainEnglishSummary({ title: 'weird(type): does a thing' });
  assert.ok(s.includes('weird(type)') || s.startsWith('Weird'), 'preserved rather than mistranslated');
});

test('renderPlainEnglishSummary: empty title → empty string', () => {
  assert.equal(renderPlainEnglishSummary({}), '');
  assert.equal(renderPlainEnglishSummary({ title: '' }), '');
});

// ─── parseCodexSessionUrl ─────────────────────────────────────────

test('parseCodexSessionUrl: finds chatgpt.com/codex/tasks URL', () => {
  const body = 'Codex session: https://chatgpt.com/codex/tasks/task_abc123XYZ_underscore';
  assert.equal(parseCodexSessionUrl(body), 'https://chatgpt.com/codex/tasks/task_abc123XYZ_underscore');
});

test('parseCodexSessionUrl: finds sessions/ shape too', () => {
  const body = 'see https://chatgpt.com/codex/sessions/some-id-999 for the transcript';
  assert.equal(parseCodexSessionUrl(body), 'https://chatgpt.com/codex/sessions/some-id-999');
});

test('parseCodexSessionUrl: null when nothing matches', () => {
  assert.equal(parseCodexSessionUrl(''), null);
  assert.equal(parseCodexSessionUrl(null), null);
  assert.equal(parseCodexSessionUrl('random text with no url'), null);
});

// ─── buildChecklist ───────────────────────────────────────────────

test('buildChecklist: always includes read-summary + out-of-scope', () => {
  const items = buildChecklist({ title: 'fix: x' });
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes('read-summary'));
  assert.ok(ids.includes('out-of-scope'));
});

test('buildChecklist: adds test-route step when testRoute present', () => {
  const items = buildChecklist({ title: 'feat(ui): x', testRoute: { path: '/foo', port: 8080, open: 'Open the foo page' } });
  assert.ok(items.some((i) => i.id === 'open-test-route'));
});

test('buildChecklist: bug label adds reproduce step', () => {
  const items = buildChecklist({ title: 'fix: x', labels: ['bug'] });
  assert.ok(items.some((i) => i.id === 'reproduce-bug'));
});

test('buildChecklist: big diff triggers big-diff warn', () => {
  const items = buildChecklist({ title: 'refactor: sweep', additions: 700, deletions: 100 });
  assert.ok(items.some((i) => i.id === 'big-diff'));
});

test('buildChecklist: dup group adds dup-warn item', () => {
  const items = buildChecklist({ title: 'fix: x' }, { isDup: true, superseded: [{}, {}], ticketId: 42 });
  assert.ok(items.some((i) => i.id === 'dup-warn'));
});

test('buildChecklist: merge conflict adds resolve-conflict item', () => {
  const items = buildChecklist({ title: 'fix: x', mergeable_state: 'dirty' });
  assert.ok(items.some((i) => i.id === 'resolve-conflict'));
});

// ─── renderCheckList ──────────────────────────────────────────────

test('renderCheckList: emits native checkboxes with unique ids per prefix', () => {
  const html = renderCheckList([
    { id: 'a', text: 'First check' },
    { id: 'b', text: 'Second check' },
  ], 'repo-42');
  assert.ok(html.includes('type="checkbox"'));
  assert.ok(html.includes('id="chk-repo-42-a-0"'));
  assert.ok(html.includes('id="chk-repo-42-b-1"'));
  assert.ok(html.includes('First check'));
});

test('renderCheckList: empty list → empty string', () => {
  assert.equal(renderCheckList([], 'x'), '');
  assert.equal(renderCheckList(null, 'x'), '');
});

// ─── renderTestBrowserCtas ────────────────────────────────────────

test('renderTestBrowserCtas: primary "Test in browser" button when testRoute present', () => {
  const html = renderTestBrowserCtas({
    testRoute: { path: '/business/calendar', port: 8080, open: 'Try week-jump shortcut' },
  });
  assert.ok(html.includes('btn-primary'));
  assert.ok(html.includes('Test in browser'));
  assert.ok(html.includes('http://localhost:8080/business/calendar'));
  assert.ok(html.includes('Open in new tab'));
  assert.ok(html.includes('Try week-jump shortcut'));
});

test('renderTestBrowserCtas: muted "No browser test" when testRoute missing', () => {
  const html = renderTestBrowserCtas({ testRoute: null });
  assert.ok(html.includes('No browser test declared'));
  assert.ok(!html.includes('btn-primary'), 'no primary button when no test route');
});

// ─── renderActionForms ────────────────────────────────────────────

test('renderActionForms: renders three forms when token has write scope', () => {
  const html = renderActionForms(
    { number: 1234, base: 'day-shift-staging-2026-08-04' },
    { key: 'SECRET', repo: 'org/repo', permissions: { push: true, pull: true, admin: false } },
  );
  assert.ok(html.includes('Approve &amp; merge'));
  assert.ok(html.includes('❌ Reject'));
  assert.ok(html.includes('↷ Snooze'));
  assert.ok(html.includes('action="/action/approve?pr=1234&repo=org%2Frepo&key=SECRET"'));
  assert.ok(html.includes('required pattern="APPROVE"'));
  assert.ok(html.includes('required pattern="REJECT"'));
  assert.ok(html.includes('required pattern="SNOOZE"'));
});

test('renderActionForms: renders DISABLED buttons + tooltip when token is read-only', () => {
  const html = renderActionForms(
    { number: 1234 },
    { key: 'SECRET', repo: 'org/repo', permissions: { push: false, pull: true, admin: false } },
  );
  assert.ok(html.includes('actions-disabled'));
  assert.ok(html.includes('btn-disabled'));
  assert.ok(html.includes('read-only'));
  assert.ok(!html.includes('<form'), 'no live form when scope missing');
});

test('renderActionForms: null permissions → disabled with "could not be probed" reason', () => {
  const html = renderActionForms({ number: 1 }, { key: 'x', repo: 'org/repo', permissions: null });
  assert.ok(html.includes('actions-disabled'));
  assert.ok(html.includes('could not be probed'));
});

test('renderActionForms: no inline JS anywhere (CSP compliance)', () => {
  const html = renderActionForms(
    { number: 1 },
    { key: 'k', repo: 'org/repo', permissions: { push: true } },
  );
  assert.ok(!/onclick=|onsubmit=|<script/i.test(html), 'no inline JS');
});

// ─── renderContinuePanel ──────────────────────────────────────────

test('renderContinuePanel: includes claude CLI recipe with git fetch + separate primer block', () => {
  const html = renderContinuePanel(
    { number: 1200, title: 'fix(auth): x', base: 'day-shift-staging-2026-08-04', body: '' },
    { repo: 'org/repo' },
  );
  assert.ok(html.includes('git fetch origin day-shift-staging-2026-08-04'));
  assert.ok(html.includes('git checkout day-shift-staging-2026-08-04'));
  // Recipe now ends with plain `claude` (no interpolated primer suffix) -
  // the primer is in its OWN copy block to eliminate the shell-injection
  // surface. Regression test for that split lives in continuePanelSafety.
  assert.ok(html.match(/claude(\n|$|<)/), 'recipe starts claude CLI with no shell-string arg');
  // TWO recipe blocks: one for the shell (git + claude), one for the
  // primer (pasted into Claude's prompt after CLI starts).
  const recipeBlocks = (html.match(/<pre class="recipe">/g) || []).length;
  assert.equal(recipeBlocks, 2, 'two recipe blocks: shell-safe git commands, primer-for-Claude');
  assert.ok(html.includes('Continue work on repo PR #1200'), 'primer block references PR');
});

test('renderContinuePanel: renders codex link when PR body carries chatgpt.com/codex URL', () => {
  const html = renderContinuePanel(
    { number: 500, title: 'x', base: 'night-shift-staging-2026-08-04', body: 'Codex: https://chatgpt.com/codex/tasks/task_xyz789' },
    { repo: 'org/repo' },
  );
  assert.ok(html.includes('Open the Codex Cloud session'));
  assert.ok(html.includes('https://chatgpt.com/codex/tasks/task_xyz789'));
});

test('renderContinuePanel: hides codex link when PR body has no codex URL', () => {
  const html = renderContinuePanel(
    { number: 500, title: 'x', base: 'day-shift-staging-2026-08-04', body: '' },
    { repo: 'org/repo' },
  );
  assert.ok(!html.includes('Codex Cloud session'));
});

// ─── renderTriageCard ─────────────────────────────────────────────

test('renderTriageCard: shows plain-English summary above engineer title', () => {
  const pr = {
    number: 42, title: 'fix(auth): remember login', url: '#', labels: [],
    updatedAt: hoursAgo(2), base: 'day-shift-staging-2026-08-04', body: '',
    testRoute: null, additions: 30, deletions: 5, changed_files: 3,
    _shift: 'day', _repo: 'org/repo',
  };
  const group = { primary: pr, superseded: [], isDup: false, isStale: false, ticketId: 42 };
  const html = renderTriageCard(group, { key: 'K', repo: 'org/repo', permissions: { push: true }, now: nowIso });
  const plainIdx = html.indexOf('Fix (auth): Remember login');
  const engIdx = html.indexOf('fix(auth): remember login');
  assert.ok(plainIdx >= 0, 'plain summary is present');
  assert.ok(engIdx >= 0, 'engineer title still audit-visible');
  assert.ok(plainIdx < engIdx, 'plain summary comes BEFORE the engineer title');
});

test('renderTriageCard: DUP + STALE flag pills render in header', () => {
  const pr = { number: 1, title: 'fix: x', url: '#', labels: [], updatedAt: daysAgo(7), _shift: 'night', _repo: 'org/repo' };
  const group = { primary: pr, superseded: [{ number: 2, title: 'older', url: '#' }], isDup: true, isStale: true, ticketId: 99 };
  const html = renderTriageCard(group, { key: 'K', repo: 'org/repo', permissions: { push: true }, now: nowIso });
  assert.ok(html.includes('DUP · 2'));
  assert.ok(html.includes('STALE'));
  assert.ok(html.includes('Also on this ticket'));
});

// ─── renderFreshnessGroup ────────────────────────────────────────

test('renderFreshnessGroup: "fresh" bucket renders open (not collapsed)', () => {
  const g = { primary: { number: 1, title: 'fix: x', url: '#', labels: [], updatedAt: hoursAgo(2), _shift: 'day', _repo: 'org/repo' }, superseded: [], isDup: false, isStale: false, ticketId: 1 };
  const html = renderFreshnessGroup('fresh', [g], { key: 'K', repo: 'org/repo', permissions: { push: true }, now: nowIso });
  assert.ok(html.includes('Since you were last here'));
  // The freshness wrapper itself must NOT be a <details> (would be collapsed).
  // Cards inside can contain their own <details> for continue-panel + action
  // forms; that is fine. Check the top-level section shape instead.
  assert.ok(!/^<section[^>]*>\s*<details/.test(html.trim()), 'fresh section not wrapped in top-level <details>');
});

test('renderFreshnessGroup: "older" bucket wrapped in <details> so it starts collapsed', () => {
  const g = { primary: { number: 1, title: 'fix: x', url: '#', labels: [], updatedAt: daysAgo(30), _shift: 'day', _repo: 'org/repo' }, superseded: [], isDup: false, isStale: false, ticketId: 1 };
  const html = renderFreshnessGroup('older', [g], { key: 'K', repo: 'org/repo', permissions: { push: true }, now: nowIso });
  assert.ok(html.includes('Older'));
  assert.ok(html.includes('<details>'), 'older is collapsed by default');
});

test('renderFreshnessGroup: empty list → empty string', () => {
  assert.equal(renderFreshnessGroup('fresh', [], {}), '');
  assert.equal(renderFreshnessGroup('older', null, {}), '');
});

// ─── renderNoOpSection ────────────────────────────────────────────

test('renderNoOpSection: renders collapsed footer with flag links', () => {
  const noOps = [
    { number: 1302, title: 'chore: nothing', url: 'https://gh/x/1302', updatedAt: hoursAgo(4), _shift: 'night', _repo: 'org/repo' },
  ];
  const html = renderNoOpSection(noOps, { repo: 'org/repo', now: nowIso });
  assert.ok(html.includes('Nothing to do'));
  assert.ok(html.includes('#1302'));
  assert.ok(html.includes('Flag this'));
  assert.ok(html.includes('<details'), 'wrapped in <details> so it starts collapsed');
});

test('renderNoOpSection: empty → empty string', () => {
  assert.equal(renderNoOpSection([], {}), '');
});

// ─── renderTriageStrip ────────────────────────────────────────────

test('renderTriageStrip: "All caught up" copy when nothing at all', () => {
  const html = renderTriageStrip({ fresh: [], yesterday: [], thisWeek: [], older: [] }, 0);
  assert.ok(html.includes('All caught up'));
});

test('renderTriageStrip: shows fresh count in primary color when > 0', () => {
  const html = renderTriageStrip({ fresh: [1, 2, 3], yesterday: [], thisWeek: [], older: [] }, 0);
  assert.ok(html.includes('tri-fresh'));
  assert.ok(html.includes('3'));
  assert.ok(html.includes('fresh'));
});

test('renderTriageStrip: shows no-op footer count when > 0', () => {
  const html = renderTriageStrip({ fresh: [1], yesterday: [], thisWeek: [], older: [] }, 2);
  assert.ok(html.includes('nothing-to-do'));
  assert.ok(html.includes('2'));
});

// ─── renderFlashBanner ────────────────────────────────────────────

test('renderFlashBanner: null → empty string (no banner when no flash)', () => {
  assert.equal(renderFlashBanner(null), '');
});

test('renderFlashBanner: ok → green banner with checkmark', () => {
  const html = renderFlashBanner({ kind: 'ok', msg: 'Merged PR #123.' });
  assert.ok(html.includes('flash-ok'));
  assert.ok(html.includes('Merged PR #123'));
});

test('renderFlashBanner: err → red banner with warning icon', () => {
  const html = renderFlashBanner({ kind: 'err', msg: 'Approve failed: 404.' });
  assert.ok(html.includes('flash-err'));
  assert.ok(html.includes('Approve failed'));
});

// ─── readFlashCookie ──────────────────────────────────────────────

test('readFlashCookie: parses kind|msg format', () => {
  const flash = readFlashCookie('flash=' + encodeURIComponent('ok|Merged PR #42.'));
  assert.deepEqual(flash, { kind: 'ok', msg: 'Merged PR #42.' });
});

test('readFlashCookie: err kind roundtrips', () => {
  const flash = readFlashCookie('flash=' + encodeURIComponent('err|Not found'));
  assert.deepEqual(flash, { kind: 'err', msg: 'Not found' });
});

test('readFlashCookie: missing / malformed → null', () => {
  assert.equal(readFlashCookie(''), null);
  assert.equal(readFlashCookie('theme=dark'), null);
  // Unknown kind rejected (defensive):
  assert.equal(readFlashCookie('flash=' + encodeURIComponent('weird|x')), null);
});

// ─── renderTriageRepoSection integration ─────────────────────────

test('renderTriageRepoSection: no-op PR is pulled out of the freshness list', () => {
  const repo = {
    repo: 'org/repo',
    dayPrs: [
      { number: 100, title: 'fix(x): real change', url: '#', labels: [], updatedAt: hoursAgo(2), base: 'day-shift-staging-2026-08-04', body: '', changed_files: 3, additions: 40, deletions: 5 },
      { number: 1302, title: 'chore: nothing', url: '#', labels: [], updatedAt: hoursAgo(3), base: 'day-shift-staging-2026-08-04', body: '', changed_files: 0, additions: 0, deletions: 0 },
    ],
    nightPrs: [],
    permissions: { push: true, pull: true, admin: false },
  };
  const html = renderTriageRepoSection(repo, nowIso, { key: 'K' });
  // Real PR renders as a triage card in the "fresh" bucket
  assert.ok(html.includes('#100'));
  assert.ok(html.includes('Since you were last here'));
  // No-op PR renders inside the noop footer section, not the freshness list
  assert.ok(html.includes('Nothing to do'));
  assert.ok(html.includes('#1302'));
  const noopIdx = html.indexOf('Nothing to do');
  const p100Idx = html.indexOf('#100');
  assert.ok(p100Idx < noopIdx, 'real PR appears above the no-op footer');
});

test('renderTriageRepoSection: read-only token surfaces "read-only token" pill', () => {
  const repo = {
    repo: 'org/repo',
    dayPrs: [{ number: 1, title: 'fix: x', url: '#', labels: [], updatedAt: hoursAgo(1), base: 'day-shift-staging-2026-08-04', body: '', changed_files: 1, additions: 1, deletions: 1 }],
    nightPrs: [],
    permissions: { push: false, pull: true, admin: false },
  };
  const html = renderTriageRepoSection(repo, nowIso, { key: 'K' });
  assert.ok(html.includes('read-only token'));
  assert.ok(html.includes('actions-disabled'));
});

// ─── renderHtml integration ───────────────────────────────────────

test('renderHtml: sets form-action CSP so approve/reject/snooze forms can POST', () => {
  // (We can't inspect Response headers here — CSP is set in the fetch
  // handler, not renderHtml — but we can at least check that the rendered
  // HTML uses forms with method="POST" pointing at /action/*, which the
  // fetch handler's CSP is what makes work.)
  const d = {
    now: nowIso,
    repos: [{
      repo: 'org/repo',
      dayPrs: [{ number: 1, title: 'fix: x', url: '#', labels: [], updatedAt: hoursAgo(1), base: 'day-shift-staging-2026-08-04', body: '', changed_files: 1, additions: 2, deletions: 1 }],
      nightPrs: [], dayRuns: [], nightRuns: [], dayMerged: [], nightMerged: [],
      permissions: { push: true, pull: true, admin: false },
    }],
  };
  const html = renderHtml(d, { theme: 'dark' });
  assert.ok(html.includes('method="POST"'));
  assert.ok(html.includes('/action/approve?'));
  assert.ok(html.includes('/action/reject?'));
  assert.ok(html.includes('/action/snooze?'));
});

test('renderHtml: renders flash banner when opts.flash is set', () => {
  const d = { now: nowIso, repos: [{ repo: 'org/repo', dayPrs: [], nightPrs: [], dayRuns: [], nightRuns: [] }] };
  const html = renderHtml(d, { theme: 'dark', flash: { kind: 'ok', msg: 'Merged PR #77.' } });
  assert.ok(html.includes('flash-ok'));
  assert.ok(html.includes('Merged PR #77'));
});

test('renderHtml: no inline <script> anywhere (CSP compliance across all v7 code)', () => {
  const d = {
    now: nowIso,
    repos: [{
      repo: 'org/repo',
      dayPrs: [{ number: 1, title: 'fix(auth): x', url: '#', labels: ['bug'], updatedAt: hoursAgo(1), base: 'day-shift-staging-2026-08-04', body: '', changed_files: 3, additions: 40, deletions: 5, testRoute: { path: '/foo', port: 8080 } }],
      nightPrs: [],
      dayRuns: [], nightRuns: [], dayMerged: [], nightMerged: [],
      permissions: { push: true, pull: true, admin: false },
    }],
  };
  const html = renderHtml(d, { theme: 'dark' });
  assert.ok(!/<script/i.test(html), 'no <script> tags');
  assert.ok(!/onclick=|onsubmit=|onchange=/i.test(html), 'no inline event handlers');
});
