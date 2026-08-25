/**
 * Cron parsing + humanization + the "Shift Schedule" rail panel.
 *
 * We only support the three cron shapes that actually appear in shift
 * workflows (daily at HH:MM, hourly at :M, every-N-minutes). Anything else
 * falls through to null and the renderer shows the raw expression - better
 * to be honest than to misrepresent an unknown schedule.
 *
 * Extracted from worker.js to keep the orchestrator file small.
 */

import { escape, fmtRel, collectAcrossRepos } from './worker.js';

/**
 * Parse a 5-field POSIX cron expression into structured fields, or return
 * null if the expression isn't in a form we handle. We deliberately only
 * cover the shapes that appear in shift workflows:
 *   `M H * * *`   → daily at H:M UTC
 *   `M * * * *`   → hourly at :M past
 *   `star/N * * * *` → every N minutes
 * Anything else (day-of-week specifics, ranges, lists) falls through to
 * null and the renderer shows the raw cron string.
 */
export function parseCron(str) {
  if (typeof str !== 'string') return null;
  const parts = str.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  // Daily at H:M
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && month === '*' && dow === '*') {
    const m = Number(minute), h = Number(hour);
    if (m < 0 || m > 59 || h < 0 || h > 23) return null;
    return { kind: 'daily', hour: h, minute: m, raw: str };
  }
  // Hourly at :M
  if (/^\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const m = Number(minute);
    if (m < 0 || m > 59) return null;
    return { kind: 'hourly', minute: m, raw: str };
  }
  // Every N minutes
  const everyN = minute.match(/^\*\/(\d+)$/);
  if (everyN && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = Number(everyN[1]);
    if (n <= 0 || n > 59) return null;
    return { kind: 'everyMinutes', interval: n, raw: str };
  }
  return null;
}

/**
 * Humanize a parsed cron into a short English string.
 * `daily`      → "Daily at 23:00 UTC"
 * `hourly`     → "Hourly at :15 past"
 * `everyMin`   → "Every 30 minutes"
 * Anything else → the raw expression back verbatim.
 */
export function humanizeCron(parsed) {
  if (!parsed) return null;
  if (parsed.kind === 'daily') {
    const hh = String(parsed.hour).padStart(2, '0');
    const mm = String(parsed.minute).padStart(2, '0');
    return `Daily at ${hh}:${mm} UTC`;
  }
  if (parsed.kind === 'hourly') {
    return `Hourly at :${String(parsed.minute).padStart(2, '0')} past`;
  }
  if (parsed.kind === 'everyMinutes') {
    return `Every ${parsed.interval} minutes`;
  }
  return parsed.raw;
}

/**
 * Compute the next UTC fire time for a parsed cron, given `fromDate`.
 * Only handles the three kinds parseCron produces. Returns null for
 * anything else - caller then just omits the "next fire in" line.
 */
export function nextFireFromCron(parsed, fromDate) {
  if (!parsed || !fromDate) return null;
  const now = new Date(fromDate);
  if (parsed.kind === 'daily') {
    const next = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      parsed.hour, parsed.minute, 0, 0,
    ));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  if (parsed.kind === 'hourly') {
    const next = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
      now.getUTCHours(), parsed.minute, 0, 0,
    ));
    if (next.getTime() <= now.getTime()) next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }
  if (parsed.kind === 'everyMinutes') {
    // Next fire = next multiple of `interval` after the current minute.
    const next = new Date(now);
    next.setUTCSeconds(0, 0);
    const rem = next.getUTCMinutes() % parsed.interval;
    next.setUTCMinutes(next.getUTCMinutes() + (parsed.interval - rem));
    if (next.getTime() <= now.getTime()) {
      next.setUTCMinutes(next.getUTCMinutes() + parsed.interval);
    }
    return next;
  }
  return null;
}

/**
 * Short humanized "in Xh Ym" / "in Xm" for a future timestamp relative
 * to `now`. Never negative - flips to "overdue" if in the past.
 */
export function humanizeUntil(future, now) {
  if (!future || !now) return '?';
  const ms = new Date(future).getTime() - new Date(now).getTime();
  if (ms < 0) return 'overdue';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return 'in <1m';
  if (totalMin < 60) return `in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

/**
 * One row of the schedule panel (NIGHT or DAY): tag + humanized schedule +
 * next fire + last dispatch outcome.
 */
function renderScheduleRow(shift, humanSchedule, nextIso, lastRun, now) {
  const shiftDot = shift === 'night' ? 'dot-accent' : 'dot-success';
  const nextTxt = nextIso ? humanizeUntil(nextIso, now) : '';
  const lastTxt = lastRun && lastRun.createdAt
    ? `last ${fmtRel(lastRun.createdAt, now).split(' · ')[0]}${lastRun.conclusion ? ' · ' + escape(lastRun.conclusion) : ''}`
    : 'no runs yet';
  return `<div class="sched-row">
    <span class="sched-tag"><span class="dot ${shiftDot}"></span>${escape(shift)}</span>
    <div class="sched-body">
      <div class="sched-line">${escape(humanSchedule)}</div>
      <div class="sched-meta">
        ${nextIso ? `<span class="sched-next">next ${escape(nextTxt)}</span>` : ''}
        <span class="sched-last">${lastTxt}</span>
      </div>
    </div>
  </div>`;
}

/**
 * "Shift Schedule" rail panel: 2 rows (NIGHT + DAY) with humanized schedule
 * + next fire + last dispatch outcome. Aggregated across repos - the cron
 * is expected to be identical across shift repos in practice.
 */
export function renderSchedulePanel(repos, now) {
  // Aggregate the first repo's cron (they should all be the same in
  // practice; if they diverge we show whichever we found first + would
  // add a per-repo detail in a follow-up).
  const nightCronStr = repos
    .map((r) => r && !r.nightCron?.error && typeof r.nightCron === 'string' ? r.nightCron : null)
    .find((c) => c) || null;
  const nightParsed = parseCron(nightCronStr);
  const nightHuman = nightParsed
    ? humanizeCron(nightParsed)
    : (nightCronStr ? `cron: ${nightCronStr}` : 'schedule unknown');
  const nightNext = nightParsed ? nextFireFromCron(nightParsed, now)?.toISOString() : null;
  const nightLast = collectAcrossRepos(repos, 'nightRuns')
    .filter((r) => r && r.createdAt)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  // Day-shift: hardcoded 30min while Mac awake. If the LaunchAgent plist
  // interval ever changes, update `dayIntervalMin` here (or lift into
  // an env var). Not fetchable from github - lives on the local Mac.
  const dayIntervalMin = 30;
  const dayHuman = `Every ${dayIntervalMin} min while Mac awake`;
  const dayLast = collectAcrossRepos(repos, 'dayRuns')
    .filter((r) => r && r.createdAt)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  const dayLastIso = dayLast?.createdAt || null;
  const dayNext = dayLastIso
    ? new Date(new Date(dayLastIso).getTime() + dayIntervalMin * 60_000).toISOString()
    : null;

  return `<section class="panel panel-schedule">
    <div class="panel-hd">
      <h2>◇ Shift Schedule</h2>
      <span class="panel-status">source: workflow yaml</span>
    </div>
    <div class="sched-list">
      ${renderScheduleRow('night', nightHuman, nightNext, nightLast, now)}
      ${renderScheduleRow('day', dayHuman, dayNext, dayLast, now)}
    </div>
    <div class="sched-foot">
      All times UTC. Edit night-shift cron in
      <code>.github/workflows/night-shift-dispatch.yml</code>.
      Day-shift is a LaunchAgent - edit
      <code>~/Library/LaunchAgents/com.example.day-shift.plist</code>.
    </div>
  </section>`;
}
