#!/usr/bin/env node
/**
 * dispatch.mjs — DAY SHIFT local dispatcher.
 *
 * Fired periodically by the LaunchAgent `com.example.day-shift` (or run by hand)
 * WHILE THE USER'S MAC IS AWAKE. It reuses night-shift's safety brain verbatim
 * (classifyIssue + verifyFirst) and swaps the runtime: instead of posting
 * `@codex`, it runs the work locally via worker.mjs → `claude -p`.
 *
 * PIPELINE
 *   1. single-instance lock (a run can take ~25 min; the timer fires every 30)
 *   2. list open issues
 *   3. classifyIssue → keep only 'safe' (auto-pick, skip the danger list)
 *   4. drop tickets already claimed by day-shift / night-shift / In-progress
 *   5. verifyFirst (preflight) → drop already-merged
 *   6. take top MAX_TICKETS (default 1), run each through the local worker
 *   7. Telegram summary
 *
 * MODES
 *   MODE=auto     — actually do the work + open draft PRs (default)
 *   MODE=dry-run  — print what WOULD be picked up; touch nothing, spawn no claude
 *
 * EXIT 0 completed · 1 config error · 2 unrecoverable
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { log, readConfig, todaysHoldingBranch, notifyTelegram, runInParallel } from './lib.mjs';
import { classifyIssue } from '../night-shift/classifier.mjs';
import { verifyFirst } from '../night-shift/preflight.mjs';
import { runWorker } from './worker.mjs';
import { classify as classifyWorkType } from './factory-router.mjs';
import {
  resolveBrainRoot,
  ensureBrainRoot,
} from '../agent-brain/storage-json.mjs';
import {
  loadRecord,
  isAutoEscalated,
  escalationReason,
} from '../agent-brain/reader.mjs';
import { summarizeForPrompt } from '../agent-brain/summarize.mjs';
import { recordAttempt } from '../agent-brain/writer.mjs';

const execFileP = promisify(execFile);
const cfg = readConfig();
const REPO = cfg.repo;
const MAX_TICKETS = cfg.maxTickets;
const MODE = cfg.mode;
const HOLDING = todaysHoldingBranch();
const LOCK_PATH = path.join(cfg.worktreeRoot, '.day-shift.lock');

// Agent Brain (per-ticket persistent state across dispatches) - opt-in via
// DAY_SHIFT_AGENT_BRAIN=1. OFF by default so upgrades don't change behavior.
// When ON: (a) tickets whose brain record is auto-escalated get skipped BEFORE
// worker fanout, (b) each worker's system prompt is prefixed with a summary of
// prior attempts + hints, (c) each dispatch's outcome is written back to the
// brain after runWorker returns. See tools/agent-brain/ + docs/architecture/AGENT_BRAIN.md.
const BRAIN_ENABLED = process.env.DAY_SHIFT_AGENT_BRAIN === '1';
const BRAIN_ROOT = BRAIN_ENABLED ? resolveBrainRoot() : null;

// Map worker sentinel → brain AttemptOutcome. Kept narrow: the brain has a
// small closed enum, and unknown sentinels fall to STUCK ("worker didn't
// produce a shippable result"), which is honest for the next dispatch.
function sentinelToOutcome(sentinel, ok) {
  if (sentinel === 'COMPLETE' && ok) return 'COMPLETE';
  if (sentinel === 'OUT-OF-SCOPE') return 'OUT-OF-SCOPE';
  if (sentinel === 'STUCK') return 'STUCK';
  return 'STUCK';
}

// Labels that mean "someone already has this" — day-shift, night-shift, humans.
const ALREADY_CLAIMED = [
  /^day-shift:/i,
  /^night-shift:/i,
  /^in[\s-]?progress$/i,
  /^ready-for-testing$/i,
];

/**
 * Day-shift-only supplementary danger list, layered ON TOP of night-shift's
 * classifyIssue(). Tightens a few money/credit surfaces the shared classifier
 * lets through (it only catches "pricing tier" / "billing engine"). Because
 * day-shift runs UNATTENDED on the user's own subscription, anything that could
 * change what a customer is charged or how credits are spent must stay manual.
 * Kept here (not in the shared classifier) so night-shift v2 isn't affected.
 */
const DAY_SHIFT_EXTRA_UNSAFE = [
  /\bprice\b/i,
  /\bpricing\b/i,
  /\bcredit\s+cost/i,
  /\bcredit\s+(spend|charge|deduct|accounting)/i,
  /\bbilling\b/i,
  /\brefund\b/i,
  /\bcoupon\b|\bdiscount\b/i,
  /billing\.constants/i,
  /\bcheckout\b/i,
];

function daySafetyOverride(issue) {
  const hay = `${issue.title}\n${issue.body || ''}`;
  for (const re of DAY_SHIFT_EXTRA_UNSAFE) {
    if (re.test(hay)) return { blocked: true, reason: `day-shift-unsafe: ${re.source.slice(0, 40)}` };
  }
  return { blocked: false };
}

/**
 * Locally, `gh` authenticates via keychain — no GH_TOKEN env needed. Only fail
 * if neither an env token NOR a working `gh auth` session is available.
 */
async function assertGhAuth() {
  if (cfg.githubToken) return;
  try {
    await execFileP('gh', ['auth', 'status']);
  } catch {
    log.error('dispatch', 'no GH_TOKEN and `gh auth status` failed — run `gh auth login`');
    process.exit(1);
  }
}

async function acquireLock() {
  await mkdir(cfg.worktreeRoot, { recursive: true });
  try {
    const prev = await readFile(LOCK_PATH, 'utf8');
    const { pid, ts } = JSON.parse(prev);
    const ageMin = (Date.now() - new Date(ts).getTime()) / 60000;
    // Stale lock (older than 2× the per-ticket cap) → steal it.
    if (ageMin < cfg.maxIterMinutes * 2 + 5) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      if (alive) {
        log.warn('dispatch', 'another-run-active', { pid, ageMin: Math.round(ageMin) });
        return false;
      }
    }
    log.warn('dispatch', 'stealing-stale-lock', { pid, ageMin: Math.round(ageMin) });
  } catch { /* no lock */ }
  await writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf8');
  return true;
}

async function releaseLock() {
  await unlink(LOCK_PATH).catch(() => {});
}

async function listOpenIssues(limit = 80) {
  const { stdout } = await execFileP('gh', [
    'issue', 'list', '--repo', REPO, '--state', 'open', '--limit', String(limit),
    '--json', 'number,title,labels,body,url,createdAt,updatedAt',
  ]);
  return JSON.parse(stdout);
}

function isClaimed(issue) {
  const names = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  return names.some((n) => ALREADY_CLAIMED.some((re) => re.test(n)));
}

async function selectTickets(issues) {
  const considered = [];
  const skipped = [];
  for (const issue of issues) {
    if (isClaimed(issue)) { skipped.push({ num: issue.number, why: 'already-claimed' }); continue; }
    const v = classifyIssue(issue);
    if (v.verdict !== 'safe') {
      skipped.push({ num: issue.number, why: v.verdict, reasons: v.reasons.slice(0, 2) });
      continue;
    }
    const override = daySafetyOverride(issue);
    if (override.blocked) {
      skipped.push({ num: issue.number, why: 'day-shift-unsafe', reasons: [override.reason] });
      continue;
    }
    considered.push(issue);
  }
  log.info('dispatch', 'classifier', { open: issues.length, safe: considered.length, skipped: skipped.length });

  const eligible = [];
  for (const issue of considered) {
    if (eligible.length >= MAX_TICKETS * 2) break;
    try {
      const verify = await verifyFirst(issue.number);
      if (verify.shouldSkip) {
        log.info('dispatch', 'preflight-skip', { num: issue.number, reason: verify.reason });
        continue;
      }
    } catch (err) {
      log.warn('dispatch', 'preflight-error', { num: issue.number, error: err.message.slice(0, 160) });
      continue; // safer to skip than risk a duplicate
    }
    // Agent Brain escalation gate. If a ticket has been auto-escalated by a
    // prior run (bounced N times, hit the safety perimeter, etc.), skip it
    // BEFORE fanout so we don't burn ~25 min of Max quota reproducing the
    // same failure. Only checked when the brain is enabled - default off.
    if (BRAIN_ENABLED) {
      try {
        const rec = await loadRecord(BRAIN_ROOT, issue.number);
        if (isAutoEscalated(rec)) {
          log.info('dispatch', 'brain-escalation-skip', {
            num: issue.number,
            reason: escalationReason(rec),
          });
          continue;
        }
      } catch (err) {
        // Brain I/O failing is not a reason to skip the ticket - just log.
        log.warn('dispatch', 'brain-read-error', { num: issue.number, error: err.message.slice(0, 160) });
      }
    }
    eligible.push(issue);
  }
  return { eligible: eligible.slice(0, MAX_TICKETS), considered, skipped };
}

async function main() {
  log.info('dispatch', 'config', { repo: REPO, maxTickets: MAX_TICKETS, mode: MODE, holding: HOLDING });
  await assertGhAuth();

  if (!(await acquireLock())) {
    log.info('dispatch', 'exit-locked');
    process.exit(0);
  }

  try {
    let issues;
    try {
      issues = await listOpenIssues();
    } catch (err) {
      log.error('dispatch', 'gh-list-failed', err.message);
      process.exit(2);
    }

    const { eligible, considered, skipped } = await selectTickets(issues);

    if (eligible.length === 0) {
      log.info('dispatch', 'no-eligible', { open: issues.length, considered: considered.length, skipped: skipped.length });
      // Quiet by default — only notify in dry-run so the timer doesn't spam.
      if (MODE === 'dry-run') {
        await notifyTelegram(`🌞 Day-shift dry-run: 0 eligible (${issues.length} open, ${skipped.length} filtered).`);
      }
      process.exit(0);
    }

    if (MODE === 'dry-run') {
      const lines = [
        `🌞 *Day-shift DRY-RUN* — would pick up ${eligible.length}:`,
        ...eligible.map((i) => `🧪 #${i.number} — ${i.title.slice(0, 70)}\n  ${i.url}`),
        '',
        `Holding branch would be \`${HOLDING}\`. Nothing was touched.`,
      ];
      log.info('dispatch', 'dry-run-selection', eligible.map((i) => ({ num: i.number, title: i.title.slice(0, 60) })));
      await notifyTelegram(lines.join('\n'));
      console.log(lines.join('\n'));
      process.exit(0);
    }

    // Concurrency-capped parallel workers. Default 1 (backward-compat with the
    // pre-parallel era). CONCURRENCY=3 was the sweet spot in bench: each
    // `claude -p` peaks at ~1-2GB RAM + 1 CPU core, so 3 concurrent fits a 16GB
    // M-series Mac without swap or perceptible desktop lag. Above 3 gives
    // diminishing returns AND burns the Claude Max 5-hour quota N× faster.
    // Each worker gets an isolated worktree at ~/day-shift-worktrees/<n>-<slug>,
    // so no shared FS state; the only race is at holding-branch push time and
    // git.mjs already serialises that per-worker via fast-forward-only pushes.
    const CONCURRENCY = Math.max(1, Math.min(cfg.concurrency, eligible.length));
    log.info('dispatch', 'worker-fanout', {
      tickets: eligible.length,
      concurrency: CONCURRENCY,
      strategy: CONCURRENCY === 1 ? 'serial (legacy)' : 'concurrency-capped parallel',
    });
    // Factory Router (ADW pattern) — opt-in via DAY_SHIFT_FACTORY_ROUTER=1.
    // OFF by default so existing installs behave exactly as before on upgrade.
    // When ON: classify each ticket by work-type (hotfix/feature/bug/chore)
    // and pass the verdict to runWorker, which loads the matching pipeline
    // definition and applies its overrides (system-prompt augment, per-track
    // wall clock). When OFF: workType stays undefined → worker uses the
    // baseline recipe exactly as today.
    const factoryRouterOn = process.env.DAY_SHIFT_FACTORY_ROUTER === '1';
    log.info('dispatch', 'factory-router', { enabled: factoryRouterOn });
    log.info('dispatch', 'agent-brain', { enabled: BRAIN_ENABLED, root: BRAIN_ROOT || null });
    if (BRAIN_ENABLED) {
      // Make sure the root directory exists once, up front, so worker fanout
      // doesn't race on mkdir. Cheap - a no-op if it already exists.
      await ensureBrainRoot(BRAIN_ROOT).catch((err) =>
        log.warn('dispatch', 'brain-ensure-root-failed', { error: err.message.slice(0, 160) }),
      );
    }
    const results = await runInParallel(eligible, CONCURRENCY, async (issue) => {
      let workType;
      if (factoryRouterOn) {
        const verdict = classifyWorkType(issue);
        workType = verdict.workType;
        log.info('dispatch', 'factory-route', {
          num: issue.number,
          workType,
          source: verdict.matched.source,
          pattern: verdict.matched.pattern,
        });
      }
      // Build a brain summary for this ticket if the brain is enabled. The
      // summary is a short markdown block the worker prepends to its system
      // prompt so it knows "you have already tried this N times, don't repeat".
      // Empty when there's no prior data - callers pass through unchanged.
      //
      // Also build a compact `brainSnapshot` object (~200 bytes) which the
      // worker embeds as an HTML comment in the PR body it opens. The
      // shift-dashboard (CF Worker) parses that block from GitHub's PR list
      // response to surface per-ticket attempt history + escalation + hint
      // counts. This is the ONE bridge between the local-Mac brain files and
      // the edge-rendered dashboard - it piggybacks on the PR body that
      // day-shift is already about to write, so no new infrastructure.
      let brainSummary = '';
      let brainSnapshot;
      let priorAttemptCount = 0;
      if (BRAIN_ENABLED) {
        try {
          const rec = await loadRecord(BRAIN_ROOT, issue.number);
          brainSummary = summarizeForPrompt(rec);
          priorAttemptCount = rec.attempts.length;
          const last = rec.attempts.length ? rec.attempts[rec.attempts.length - 1] : null;
          brainSnapshot = {
            schemaVersion: 1,
            ticketId: rec.ticket_id,
            attempts: rec.attempts.length,
            lastOutcome: last ? last.outcome : null,
            lastDurationSec: last ? last.duration_sec : null,
            hints: rec.hints.length,
            escalated: Boolean(rec.escalation && rec.escalation.auto_escalate),
            updatedAt: rec.updated_at,
          };
        } catch (err) {
          log.warn('dispatch', 'brain-summary-failed', { num: issue.number, error: err.message.slice(0, 160) });
        }
      }
      log.info('dispatch', 'worker-start', {
        num: issue.number,
        title: issue.title.slice(0, 60),
        workType,
        brainPriorAttempts: priorAttemptCount,
      });
      const startedAt = Date.now();
      let workerResult;
      try {
        workerResult = await runWorker(issue, { workType, brainSummary, brainSnapshot });
      } catch (err) {
        log.error('dispatch', 'worker-threw', { num: issue.number, error: err.message });
        workerResult = { ok: false, sentinel: 'ERROR', reason: err.message.slice(0, 160) };
      }
      // Persist the attempt to the brain after the worker finishes (or throws).
      // Never let a brain write failure crash the dispatcher - the worker's
      // primary output (the PR / label / comment) has already landed.
      if (BRAIN_ENABLED) {
        const durationSec = Math.round((Date.now() - startedAt) / 1000);
        try {
          await recordAttempt(BRAIN_ROOT, issue.number, {
            shift: 'day',
            worker_id: `pid-${process.pid}`,
            branch: `dayshift/${issue.number}`,
            pr_url: workerResult.prUrl || null,
            outcome: sentinelToOutcome(workerResult.sentinel, workerResult.ok),
            duration_sec: durationSec,
            error_summary: workerResult.reason ? workerResult.reason.slice(0, 240) : undefined,
          });
        } catch (err) {
          log.warn('dispatch', 'brain-write-failed', { num: issue.number, error: err.message.slice(0, 160) });
        }
      }
      return { issue, r: workerResult };
    });

    const shipped = results.filter((x) => x.r.ok && x.r.prUrl);
    const lines = [
      `🌞 *Day-shift run* — ${shipped.length}/${results.length} draft PRs on \`${HOLDING}\``,
      '',
      ...results.map((x) => {
        const tag = x.r.prUrl ? '✅' : x.r.sentinel === 'OUT-OF-SCOPE' ? '↩️' : '⚠️';
        const tail = x.r.prUrl || `(${x.r.sentinel}${x.r.reason ? ': ' + x.r.reason : ''})`;
        return `${tag} #${x.issue.number} — ${x.issue.title.slice(0, 60)}\n  ${tail}`;
      }),
      '',
      `Review at your desk, then promote \`${HOLDING}\` → Staging.`,
    ];
    await notifyTelegram(lines.join('\n'));
    console.log(lines.join('\n'));
    process.exit(0);
  } finally {
    await releaseLock();
  }
}

main().catch(async (err) => {
  log.error('dispatch', 'unhandled', err.message);
  await releaseLock();
  process.exit(2);
});
