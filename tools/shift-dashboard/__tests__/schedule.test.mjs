// Tests for the schedule panel + cron helpers.
//
// parseCron only handles the shapes shift workflows actually use:
//   - Daily at HH:MM  (M H * * *)
//   - Hourly at :M    (M * * * *)
//   - Every N minutes (star/N * * * *)
// Anything else falls back to null (renderer shows the raw cron string).
//
// Run: node --test tools/shift-dashboard/__tests__/schedule.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCron,
  humanizeCron,
  nextFireFromCron,
  humanizeUntil,
  renderSchedulePanel,
} from '../cron.js';

// ─── parseCron ───────────────────────────────────────────────────────

test('parseCron: daily at 23:00 (matches night-shift-dispatch.yml today)', () => {
  const p = parseCron('0 23 * * *');
  assert.deepEqual(p, { kind: 'daily', hour: 23, minute: 0, raw: '0 23 * * *' });
});

test('parseCron: daily at non-round minute', () => {
  const p = parseCron('45 6 * * *');
  assert.equal(p.kind, 'daily');
  assert.equal(p.hour, 6);
  assert.equal(p.minute, 45);
});

test('parseCron: hourly at :30 past', () => {
  const p = parseCron('30 * * * *');
  assert.deepEqual(p, { kind: 'hourly', minute: 30, raw: '30 * * * *' });
});

test('parseCron: every 15 minutes', () => {
  const p = parseCron('*/15 * * * *');
  assert.deepEqual(p, { kind: 'everyMinutes', interval: 15, raw: '*/15 * * * *' });
});

test('parseCron: null for unhandled shapes', () => {
  assert.equal(parseCron('0 9 * * MON-FRI'), null);   // day-of-week list
  assert.equal(parseCron('0 9,17 * * *'), null);      // hour list
  assert.equal(parseCron('0-30 * * * *'), null);      // minute range
  assert.equal(parseCron('0 0 1 * *'), null);         // day-of-month
  assert.equal(parseCron(''), null);
  assert.equal(parseCron('too few'), null);
  assert.equal(parseCron('0 0 * * * *'), null);       // 6 fields
});

test('parseCron: null for bad numeric fields', () => {
  assert.equal(parseCron('60 * * * *'), null);   // minute 60
  assert.equal(parseCron('0 24 * * *'), null);   // hour 24
  assert.equal(parseCron('*/0 * * * *'), null);  // interval 0
  assert.equal(parseCron('*/60 * * * *'), null); // interval 60
});

// ─── humanizeCron ────────────────────────────────────────────────────

test('humanizeCron: daily → "Daily at HH:MM UTC"', () => {
  assert.equal(humanizeCron(parseCron('0 23 * * *')), 'Daily at 23:00 UTC');
  assert.equal(humanizeCron(parseCron('5 3 * * *')), 'Daily at 03:05 UTC');
});

test('humanizeCron: hourly', () => {
  assert.equal(humanizeCron(parseCron('30 * * * *')), 'Hourly at :30 past');
});

test('humanizeCron: every N minutes', () => {
  assert.equal(humanizeCron(parseCron('*/15 * * * *')), 'Every 15 minutes');
});

test('humanizeCron: null in → null out (caller falls back to raw)', () => {
  assert.equal(humanizeCron(null), null);
});

// ─── nextFireFromCron ────────────────────────────────────────────────

test('nextFireFromCron: daily - if current time is before today\'s fire, it\'s today', () => {
  const parsed = parseCron('0 23 * * *');
  const now = '2026-08-03T12:00:00Z'; // noon UTC, before 23:00 today
  const next = nextFireFromCron(parsed, now);
  assert.equal(next.toISOString(), '2026-08-03T23:00:00.000Z');
});

test('nextFireFromCron: daily - if past today\'s fire, tomorrow', () => {
  const parsed = parseCron('0 23 * * *');
  const now = '2026-08-03T23:30:00Z'; // 30 min past today's 23:00 fire
  const next = nextFireFromCron(parsed, now);
  assert.equal(next.toISOString(), '2026-08-04T23:00:00.000Z');
});

test('nextFireFromCron: everyMinutes - rounds up to next interval multiple', () => {
  const parsed = parseCron('*/30 * * * *');
  const now = '2026-08-03T14:07:00Z';
  const next = nextFireFromCron(parsed, now);
  assert.equal(next.toISOString(), '2026-08-03T14:30:00.000Z');
});

test('nextFireFromCron: everyMinutes - if exactly on boundary, advance to next', () => {
  const parsed = parseCron('*/30 * * * *');
  const now = '2026-08-03T14:00:00Z';
  const next = nextFireFromCron(parsed, now);
  assert.equal(next.toISOString(), '2026-08-03T14:30:00.000Z');
});

test('nextFireFromCron: hourly', () => {
  const parsed = parseCron('15 * * * *');
  const now = '2026-08-03T14:00:00Z';
  const next = nextFireFromCron(parsed, now);
  assert.equal(next.toISOString(), '2026-08-03T14:15:00.000Z');
});

test('nextFireFromCron: null in → null out', () => {
  assert.equal(nextFireFromCron(null, '2026-08-03T00:00:00Z'), null);
});

// ─── humanizeUntil ───────────────────────────────────────────────────

test('humanizeUntil: minutes only', () => {
  assert.equal(humanizeUntil('2026-08-03T14:30:00Z', '2026-08-03T14:15:00Z'), 'in 15m');
});

test('humanizeUntil: hours + minutes', () => {
  assert.equal(humanizeUntil('2026-08-03T18:20:00Z', '2026-08-03T14:00:00Z'), 'in 4h 20m');
});

test('humanizeUntil: hours only', () => {
  assert.equal(humanizeUntil('2026-08-03T18:00:00Z', '2026-08-03T14:00:00Z'), 'in 4h');
});

test('humanizeUntil: past → "overdue"', () => {
  assert.equal(humanizeUntil('2026-08-03T14:00:00Z', '2026-08-03T14:30:00Z'), 'overdue');
});

test('humanizeUntil: < 1 minute → "in <1m"', () => {
  assert.equal(humanizeUntil('2026-08-03T14:00:15Z', '2026-08-03T14:00:00Z'), 'in <1m');
});

// ─── renderSchedulePanel ─────────────────────────────────────────────

test('renderSchedulePanel: shows both NIGHT + DAY rows', () => {
  const html = renderSchedulePanel([{
    repo: 'x/y',
    nightCron: '0 23 * * *',
    nightRuns: [{ runNumber: 42, createdAt: '2026-08-02T23:00:00Z', status: 'completed', conclusion: 'success', url: 'u' }],
    dayRuns: [{ runNumber: 87, createdAt: '2026-08-03T14:00:00Z', status: 'completed', conclusion: 'success', url: 'u' }],
  }], '2026-08-03T15:00:00Z');
  assert.ok(html.includes('panel-schedule'));
  assert.ok(html.includes('night'));
  assert.ok(html.includes('day'));
  assert.ok(html.includes('Daily at 23:00 UTC'));
  assert.ok(html.includes('Every 30 min while Mac awake'));
});

test('renderSchedulePanel: renders "next fire in Xh" for night', () => {
  const html = renderSchedulePanel([{
    repo: 'x/y',
    nightCron: '0 23 * * *',
    nightRuns: [], dayRuns: [],
  }], '2026-08-03T15:00:00Z'); // 8 hours before 23:00
  assert.ok(html.includes('next in 8h') || html.includes('next\nin 8h') || html.match(/next[^<]*in 8h/));
});

test('renderSchedulePanel: falls back to raw cron when unhandled shape', () => {
  const html = renderSchedulePanel([{
    repo: 'x/y',
    nightCron: '0 9 * * MON-FRI',
    nightRuns: [], dayRuns: [],
  }], '2026-08-03T15:00:00Z');
  assert.ok(html.includes('cron: 0 9 * * MON-FRI') || html.includes('0 9 * * MON-FRI'));
});

test('renderSchedulePanel: gracefully handles missing nightCron (error shape)', () => {
  const html = renderSchedulePanel([{
    repo: 'x/y',
    nightCron: { error: 'no scope' },
    nightRuns: [], dayRuns: [],
  }], '2026-08-03T15:00:00Z');
  assert.ok(html.includes('schedule unknown') || html.includes('Shift Schedule'));
});

test('renderSchedulePanel: includes edit-location footnote (points to source files)', () => {
  const html = renderSchedulePanel([{
    repo: 'x/y', nightCron: '0 23 * * *', nightRuns: [], dayRuns: [],
  }], '2026-08-03T15:00:00Z');
  assert.ok(html.includes('night-shift-dispatch.yml'));
  assert.ok(html.includes('com.example.day-shift.plist'));
});

test('renderSchedulePanel: schedule copy stays generic (no hardcoded project name)', () => {
  const html = renderSchedulePanel([{
    repo: 'someone/other', nightCron: '0 23 * * *', nightRuns: [], dayRuns: [],
  }], '2026-08-03T15:00:00Z');
  // Portability guard: the schedule copy must not leak the dashboard maintainer's
  // own project names or environment names. If a project-specific string ever
  // needs to render here, parameterize it per-repo instead.
  assert.ok(!html.includes('your-project'));
  assert.ok(!html.includes('your-org'));
});
