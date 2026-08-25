// Tests for the v4 UX rework - dense ticket-grouped PR table + supersede
// detection + stale dimming + state-strip aggregates.
//
// Run: node --test tools/shift-dashboard/__tests__/prTable.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTicketId,
  groupByTicket,
  renderPrDeltaCell,
  prStatusInfo,
  renderPrRow,
  renderPrTable,
  renderStateStrip,
} from '../worker.js';

// ─── parseTicketId ──────────────────────────────────────────────────

test('parseTicketId: parenthesised trailing ref in title (canonical shift format)', () => {
  assert.equal(parseTicketId('feat(business): calendar shortcuts (#1250)', ''), 1250);
  assert.equal(parseTicketId('fix(auth): remember login method (#1240)  ', ''), 1240);
});

test('parseTicketId: bare hash in title', () => {
  assert.equal(parseTicketId('fix: something for #789', ''), 789);
});

test('parseTicketId: falls back to Closes/Fixes/Refs in body', () => {
  assert.equal(parseTicketId('untitled', 'Closes #1234'), 1234);
  assert.equal(parseTicketId('untitled', 'Fixes #567'), 567);
  assert.equal(parseTicketId('untitled', 'Refs #99999'), 99999);
});

test('parseTicketId: case-insensitive on body keywords', () => {
  assert.equal(parseTicketId('untitled', 'CLOSES #12'), 12);
  assert.equal(parseTicketId('untitled', 'fixes  #34'), 34);
});

test('parseTicketId: returns null when nothing matches', () => {
  assert.equal(parseTicketId('chore(deps): bump vite', 'random body text'), null);
  assert.equal(parseTicketId('', ''), null);
  assert.equal(parseTicketId(null, undefined), null);
});

test('parseTicketId: parenthesised ref beats bare hash (both present)', () => {
  // "feat: title #45 (#1234)" - the trailing (#1234) is the canonical marker.
  assert.equal(parseTicketId('feat: title #45 (#1234)', ''), 1234);
});

test('parseTicketId: does NOT read bare #NNNN from body (avoids code-snippet noise)', () => {
  // A snippet in the body like `#1234` should not accidentally claim a ticket.
  // Only keyword-prefixed refs count.
  assert.equal(parseTicketId('untitled', 'see #1234 in the code'), null);
  assert.equal(parseTicketId('untitled', '```\n#1234\n```'), null);
});

// ─── groupByTicket ──────────────────────────────────────────────────

const nowIso = '2026-08-03T12:00:00Z';
const hoursAgo = (h) => new Date(new Date(nowIso).getTime() - h * 3600e3).toISOString();

test('groupByTicket: same ticketId collapses into one group, newest is primary', () => {
  const prs = [
    { number: 101, ticketId: 42, updatedAt: hoursAgo(24), title: 'old' },
    { number: 102, ticketId: 42, updatedAt: hoursAgo(2), title: 'new' },
  ];
  const groups = groupByTicket(prs, { now: nowIso });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ticketId, 42);
  assert.equal(groups[0].primary.number, 102, 'newest is primary');
  assert.equal(groups[0].superseded.length, 1);
  assert.equal(groups[0].superseded[0].number, 101);
  assert.equal(groups[0].isDup, true);
});

test('groupByTicket: PRs with no ticketId become singleton orphan groups', () => {
  const prs = [
    { number: 200, ticketId: null, updatedAt: hoursAgo(1) },
    { number: 201, ticketId: null, updatedAt: hoursAgo(2) },
  ];
  const groups = groupByTicket(prs, { now: nowIso });
  assert.equal(groups.length, 2, 'orphans stay separate even if both have null ticket');
  assert.equal(groups.every((g) => g.ticketId === null), true);
  assert.equal(groups.every((g) => g.isDup === false), true);
});

test('groupByTicket: isStale true when primary older than staleDays', () => {
  const prs = [
    { number: 1, ticketId: 10, updatedAt: hoursAgo(24 * 6) },
    { number: 2, ticketId: 20, updatedAt: hoursAgo(24 * 2) },
  ];
  const groups = groupByTicket(prs, { now: nowIso, staleDays: 5 });
  const g10 = groups.find((g) => g.ticketId === 10);
  const g20 = groups.find((g) => g.ticketId === 20);
  assert.equal(g10.isStale, true, '6 days old > 5 day threshold');
  assert.equal(g20.isStale, false);
});

test('groupByTicket: sort - fresh actionable first, stale last', () => {
  const prs = [
    { number: 1, ticketId: 10, updatedAt: hoursAgo(24 * 8) }, // stale
    { number: 2, ticketId: 20, updatedAt: hoursAgo(1) },      // fresh
    { number: 3, ticketId: 30, updatedAt: hoursAgo(24 * 6) }, // stale
    { number: 4, ticketId: 40, updatedAt: hoursAgo(6) },      // fresh
  ];
  const groups = groupByTicket(prs, { now: nowIso });
  assert.equal(groups[0].primary.number, 2, 'freshest first');
  assert.equal(groups[1].primary.number, 4);
  assert.equal(groups[2].isStale, true, 'stale group at bottom');
  assert.equal(groups[3].isStale, true);
});

test('groupByTicket: fresh-newer attempt hides stale-older attempt', () => {
  // Ticket has one very-old and one recent PR. Group is NOT stale (recent
  // work exists), older PR is superseded.
  const prs = [
    { number: 10, ticketId: 99, updatedAt: hoursAgo(24 * 7), title: 'old attempt' },
    { number: 11, ticketId: 99, updatedAt: hoursAgo(1), title: 'fresh retry' },
  ];
  const groups = groupByTicket(prs, { now: nowIso, staleDays: 5 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].primary.number, 11);
  assert.equal(groups[0].isStale, false, 'group inherits primary age, not superseded');
  assert.equal(groups[0].superseded.length, 1);
});

test('groupByTicket: empty input → empty array (no crash)', () => {
  assert.deepEqual(groupByTicket([], { now: nowIso }), []);
  assert.deepEqual(groupByTicket(null, { now: nowIso }), []);
});

// ─── renderPrDeltaCell ──────────────────────────────────────────────

test('renderPrDeltaCell: all fields present renders files + colored plus/minus', () => {
  const html = renderPrDeltaCell({ changed_files: 3, additions: 42, deletions: 12 });
  assert.ok(html.includes('3f'));
  assert.ok(html.includes('+42'));
  assert.ok(html.includes('-12'));
});

test('renderPrDeltaCell: enrichment failed (all null) → dash placeholder', () => {
  const html = renderPrDeltaCell({ changed_files: null, additions: null, deletions: null });
  assert.ok(html.includes('-'));
  assert.ok(html.includes('empty'));
});

test('renderPrDeltaCell: big change (100-500 lines) → warn class', () => {
  const html = renderPrDeltaCell({ changed_files: 8, additions: 320, deletions: 4 });
  assert.ok(html.includes('delta-total big'));
});

test('renderPrDeltaCell: huge change (>=500) → danger class', () => {
  const html = renderPrDeltaCell({ changed_files: 21, additions: 892, deletions: 34 });
  assert.ok(html.includes('delta-total huge'));
});

// ─── prStatusInfo ───────────────────────────────────────────────────

test('prStatusInfo: needs-human wins over everything', () => {
  const info = prStatusInfo({
    labels: ['day-shift:needs-human', 'day-shift:reviewed-clean'],
    isDraft: true, mergeable_state: 'dirty',
  });
  assert.equal(info.cls, 'human');
});

test('prStatusInfo: merge conflict beats clean review', () => {
  const info = prStatusInfo({
    labels: ['day-shift:reviewed-clean'],
    mergeable_state: 'dirty',
  });
  assert.equal(info.cls, 'conflict');
});

test('prStatusInfo: reviewed-clean beats draft', () => {
  const info = prStatusInfo({
    labels: ['day-shift:reviewed-clean'],
    isDraft: true,
  });
  assert.equal(info.cls, 'clean');
});

test('prStatusInfo: draft when no clean label', () => {
  const info = prStatusInfo({ labels: [], isDraft: true });
  assert.equal(info.cls, 'draft');
});

test('prStatusInfo: default ready when nothing else matches', () => {
  const info = prStatusInfo({ labels: [], isDraft: false });
  assert.equal(info.cls, '');
  assert.ok(info.text.includes('ready'));
});

// ─── renderPrRow (integration) ─────────────────────────────────────

test('renderPrRow: renders as <details> with grid summary + expandable body', () => {
  const pr = {
    number: 1291, title: 'feat: X (#1250)', url: 'https://gh/x/1291',
    updatedAt: hoursAgo(1), labels: [], isDraft: true, _shift: 'day', _repo: 'org/x',
    ticketId: 1250, changed_files: 3, additions: 87, deletions: 4,
    brain: null, testRoute: null, base: 'day-shift-staging-2026-08-03',
  };
  const g = { ticketId: 1250, primary: pr, superseded: [], isStale: false, isDup: false };
  const html = renderPrRow(g, nowIso);
  assert.ok(html.startsWith('<details class="pr"'), 'row wraps in <details>');
  assert.ok(html.includes('#1291'), 'PR number shown');
  assert.ok(html.includes('#1250'), 'ticket id shown');
  assert.ok(html.includes('draft'), 'draft status pill');
  assert.ok(html.includes('3f'), 'files count in delta cell');
  assert.ok(html.includes('+87'), 'additions in delta cell');
  assert.ok(html.includes('Open on GitHub'), 'body has github link');
});

test('renderPrRow: DUP flag when superseded is non-empty', () => {
  const primary = { number: 1290, title: 't', url: 'u', updatedAt: hoursAgo(1), labels: [], _shift: 'day' };
  const older = { number: 1250, title: 'older attempt', url: 'u2', updatedAt: hoursAgo(20), _shift: 'night' };
  const g = { ticketId: 42, primary, superseded: [older], isStale: false, isDup: true };
  const html = renderPrRow(g, nowIso);
  assert.ok(html.includes('flag dup'), 'DUP flag pill present');
  assert.ok(html.includes('super-list'), 'superseded list rendered in body');
  assert.ok(html.includes('#1250'), 'superseded PR number listed');
  assert.ok(html.includes('older attempt'), 'superseded PR title listed');
});

test('renderPrRow: STALE class on <details> + STALE flag pill when isStale', () => {
  const pr = { number: 1265, title: 'chore', url: 'u', updatedAt: hoursAgo(24 * 7), labels: [], _shift: 'night' };
  const g = { ticketId: null, primary: pr, superseded: [], isStale: true, isDup: false };
  const html = renderPrRow(g, nowIso);
  assert.ok(html.includes('class="pr stale"'), 'row dimmed via .stale class');
  assert.ok(html.includes('flag stale'), 'STALE flag pill visible');
});

test('renderPrRow: HTML-escapes titles (XSS defence)', () => {
  const pr = { number: 1, title: '<script>alert(1)</script>', url: 'u', updatedAt: hoursAgo(1), labels: [], _shift: 'day' };
  const g = { ticketId: null, primary: pr, superseded: [], isStale: false, isDup: false };
  const html = renderPrRow(g, nowIso);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderPrRow: shift class picks up on night for restyling', () => {
  const pr = { number: 1, title: 't', url: 'u', updatedAt: hoursAgo(1), labels: [], _shift: 'night' };
  const g = { ticketId: null, primary: pr, superseded: [], isStale: false, isDup: false };
  const html = renderPrRow(g, nowIso);
  assert.ok(html.includes('pr-shift night'), 'night gets night-styled shift pill');
});

// ─── renderPrTable ──────────────────────────────────────────────────

test('renderPrTable: renders table head + one row per group', () => {
  const groups = [
    { ticketId: null, primary: { number: 1, title: 'a', url: 'u', updatedAt: nowIso, labels: [], _shift: 'day' },
      superseded: [], isStale: false, isDup: false },
    { ticketId: null, primary: { number: 2, title: 'b', url: 'u', updatedAt: nowIso, labels: [], _shift: 'day' },
      superseded: [], isStale: false, isDup: false },
  ];
  const html = renderPrTable(groups, nowIso);
  assert.ok(html.includes('pr-thead'), 'header row rendered');
  assert.ok(html.includes('pr-table'), 'table wrapper');
  assert.ok(html.match(/<details class="pr[^"]*">/g)?.length === 2, 'one details per group');
});

// ─── renderStateStrip ───────────────────────────────────────────────

test('renderStateStrip: aggregates open + blockers + dups + ready + stale', () => {
  const repos = [{
    repo: 'x/y',
    dayPrs: [
      { number: 1, ticketId: 10, labels: [], updatedAt: hoursAgo(1) },
      { number: 2, ticketId: 20, labels: ['day-shift:needs-human'], updatedAt: hoursAgo(2) },
      { number: 3, ticketId: 30, labels: [], updatedAt: hoursAgo(24 * 8) }, // stale
    ],
    nightPrs: [
      { number: 4, ticketId: 20, labels: [], updatedAt: hoursAgo(4) }, // dup ticket 20
    ],
    dayMerged: [{ number: 100 }],
    nightMerged: [],
  }];
  const html = renderStateStrip(repos);
  assert.ok(html.includes('state-strip'));
  assert.ok(html.match(/>4</), 'open = 4');
  assert.ok(html.includes('blockers'));
  assert.ok(html.includes('dup tickets'));
  assert.ok(html.includes('ready to promote'));
  assert.ok(html.includes('stale'));
});

test('renderStateStrip: empty repos gracefully renders zeros', () => {
  const html = renderStateStrip([]);
  assert.ok(html.includes('state-strip'));
  assert.ok(html.includes('open'));
});
