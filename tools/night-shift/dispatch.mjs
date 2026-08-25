#!/usr/bin/env node
/**
 * dispatch.mjs - night-shift v2 cloud dispatcher.
 *
 * Called by `.github/workflows/night-shift-dispatch.yml` (cron 23:00 UTC + manual + Telegram).
 * No local Mac dependencies.
 * Runs as a GitHub Action job; uses `gh` CLI (pre-installed on ubuntu-latest runners).
 *
 * WORKFLOW
 *   1. List open issues for the repo.
 *   2. For each: run `classifyIssue` to filter unsafe/in-progress/vague tickets.
 *   3. For each remaining: run `verifyFirst` (preflight) to drop tickets already
 *      addressed by a merged PR.
 *   4. Take top MAX_TICKETS (default 1).
 *   5. Create a draft PR for each selected ticket and post the `@codex` task
 *      on that PR, which is the Codex GitHub connector trigger surface.
 *   6. Label the issue `night-shift:dispatched-YYYY-MM-DD`.
 *   7. Send a Telegram summary (if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID set).
 *
 * MODES
 *   MODE=auto     - create draft PRs and post @codex comments (default)
 *   MODE=dry-run  - log what WOULD be dispatched, post nothing
 *
 * EXIT CODES
 *   0  - completed (dispatched N tickets, or 0 if none eligible)
 *   1  - configuration error (missing GH_TOKEN, etc.)
 *   2  - unrecoverable failure (gh CLI broke partway through)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import {
  log,
  readConfig,
  todaysBatchBranch,
  slugifyTitle,
  notifyTelegram,
} from './lib.mjs';
import { classifyIssue } from './classifier.mjs';
import { verifyFirst } from './preflight.mjs';

const execFileP = promisify(execFile);

const cfg = readConfig();
const REPO = cfg.repo;
const MAX_TICKETS = cfg.maxTickets;
const MODE = cfg.mode;
const TODAY_BRANCH = todaysBatchBranch();

if (!cfg.githubToken) {
  log.error('dispatch', 'missing GH_TOKEN / GITHUB_TOKEN env var');
  process.exit(1);
}

log.info('dispatch', 'config', {
  repo: REPO,
  maxTickets: MAX_TICKETS,
  mode: MODE,
  todayBranch: TODAY_BRANCH,
});

/**
 * Retry a `gh` invocation on transient errors. Motivating incident: on
 * 2026-07-22 run 29946488083, `gh pr create` failed even though the base +
 * head branches were correctly set up on the remote (verified post-hoc); a
 * manual retry ~30s later succeeded (opened test PR #1169). Likely race
 * between push visibility and PR creation.
 *
 * Retries ONLY on error messages that look transient (network / eventual
 * consistency). Auth failures / bad-args exit immediately - no point
 * retrying an unauthorized token.
 *
 * Called by the small set of GH mutations in this file that create the
 * task PR + attach the @codex comment - the ones that can race on push
 * propagation. Read-only calls elsewhere are not wrapped.
 */
const TRANSIENT_GH_ERROR_PATTERNS = [
  /no commits between/i,        // push not yet visible on the API side
  /rate limit/i,                // GH throttling
  /server error/i,              // 5xx
  /internal error/i,            // 5xx variant
  /network is unreachable/i,    // DNS / TCP glitch
  /timed? ?out/i,               // "time out" / "timed out" / "timeout" (one word)
  /gateway timeout/i,           // 504
  /service unavailable/i,       // 503
  /502 bad gateway/i,           // 502
  /econnreset/i,                // TCP reset
  /econnrefused/i,              // Node's error code for a refused connection
  /connection refused/i,        // (redundant with ECONNREFUSED but keeps plain-English matches)
];

async function execGhWithRetry(args, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? 5000;
  const attemptLabel = opts.label ?? args.slice(0, 2).join(' ');

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await execFileP('gh', args);
    } catch (err) {
      lastErr = err;
      const msg = String(err.stderr || err.message || '');
      const isTransient = TRANSIENT_GH_ERROR_PATTERNS.some((re) => re.test(msg));
      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }
      const wait = backoffMs * attempt;   // 5s, 10s
      log.warn('dispatch', 'gh-retry', {
        cmd: attemptLabel,
        attempt,
        maxAttempts,
        waitMs: wait,
        reason: msg.slice(0, 200),
      });
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * Page through open issues.
 * `gh issue list` defaults to 30; we ask for more so the classifier has a wider net.
 */
async function listOpenIssues(limit = 80) {
  try {
    const { stdout } = await execFileP('gh', [
      'issue', 'list',
      '--repo', REPO,
      '--state', 'open',
      '--limit', String(limit),
      '--json', 'number,title,labels,body,url,createdAt,updatedAt',
    ]);
    return JSON.parse(stdout);
  } catch (err) {
    log.error('dispatch', 'gh issue list failed', err.message);
    throw new Error('LIST_ISSUES_FAILED');
  }
}

/**
 * Filter pipeline:
 *   raw issues → classify-safe → preflight-pass → top N → ready to dispatch
 */
async function selectTickets(issues) {
  const considered = [];
  const skipped = [];

  for (const issue of issues) {
    const verdict = classifyIssue(issue);
    if (verdict.verdict !== 'safe') {
      skipped.push({
        num: issue.number,
        title: issue.title.slice(0, 60),
        verdict: verdict.verdict,
        reasons: verdict.reasons.slice(0, 2),
      });
      continue;
    }
    considered.push(issue);
  }

  log.info('dispatch', 'classifier', {
    open: issues.length,
    safeCandidates: considered.length,
    skipped: skipped.length,
  });
  if (process.env.NIGHT_SHIFT_DEBUG) {
    log.debug('dispatch', 'skipped-detail', skipped.slice(0, 10));
  }

  // Preflight: drop tickets that already have a merged PR addressing them.
  const eligible = [];
  for (const issue of considered) {
    if (eligible.length >= MAX_TICKETS * 2) break; // small headroom; stop scanning early
    try {
      const verify = await verifyFirst(issue.number);
      if (verify.shouldSkip) {
        log.info('dispatch', 'preflight-skip', {
          num: issue.number,
          reason: verify.reason || 'preflight-said-skip',
          ...(verify.mergedPR ? { mergedPR: verify.mergedPR } : {}),
        });
        continue;
      }
    } catch (err) {
      log.warn('dispatch', 'preflight-error', {
        num: issue.number,
        error: err.message.slice(0, 200),
      });
      // Don't pick it - safer to skip a ticket than ship a duplicate.
      continue;
    }
    eligible.push(issue);
  }

  return { eligible: eligible.slice(0, MAX_TICKETS), considered, skipped };
}

/**
 * Build the Codex connector prompt for a ticket.
 */
function buildCodexPrompt(issue) {
  const slug = slugifyTitle(issue.title);
  return `@codex Night shift autonomous run.

**Read \`AGENTS.md\` end-to-end before making any change.** It contains the safety perimeter, credit ceiling (300 cr hard cap), branch rules, no-pause rule, and PR body template - all non-negotiable.

**Task.** Attempt this one ticket: ${issue.url}

**Branch.** \`nightshift/${issue.number}-${slug}\` based on \`Staging\`.

**PR target.** Continue in this draft PR against \`${TODAY_BRANCH}\`. Never retarget it to \`Staging\` or \`main\` directly.

**Scope.** One feature only. Do not refactor adjacent code. Do not "fix unrelated lint along the way." If the work hits a safety-perimeter path or exceeds the 300-credit ceiling, exit cleanly with a comment - do not pause for human input.

**PR body MUST include the template from AGENTS.md section 5**: Hypothesis / Root cause / Fix / What didn't work / Test evidence / Tickets dedup-checked.

**Verify before push.** \`npm run typecheck && npm test\`. If \`npm run typecheck\` is not defined, run \`npx tsc --noEmit\` instead. Both green. If a critical-path is touched (cinematic chat, calendar, brand profile, payments, onboarding), add or extend an \`e2e/\` Playwright spec in the same PR.

Auto-dispatched by night-shift v2 at $(timestamp).`;
}

async function applyDispatchLabel(issue) {
  const label = `night-shift:dispatched-${TODAY_BRANCH.replace('night-shift-staging-', '')}`;
  try {
    await execFileP('gh', [
      'label', 'create', label,
      '--repo', REPO,
      '--description', `Auto-dispatched to night-shift on ${TODAY_BRANCH}`,
      '--color', '0E8A16',
    ]);
  } catch {
    // Label likely already exists. Ignore.
  }
  await execFileP('gh', [
    'issue', 'edit', String(issue.number),
    '--repo', REPO,
    '--add-label', label,
  ]);
  return label;
}

async function remoteBranchExists(branch) {
  try {
    await execFileP('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure today's batch/holding branch exists AND is up to date with
 * origin/Staging. Original bug (fixed 2026-07-22): if the branch existed
 * from an earlier dispatch today, this function returned early and never
 * refreshed it. When Staging moved later that day, every subsequent PR
 * against TODAY_BRANCH showed all the Staging drift as "diff" - producing
 * multi-hundred-line PRs that swept in perimeter files (server.js,
 * migrations, .github/workflows/*) the agent never intentionally touched.
 * Live evidence: PRs #936, #1078, #1150 (49-71 commits each, all labelled
 * night-shift:needs-human on 2026-07-21).
 *
 * Refresh strategy:
 *  - Not yet on remote → create it from origin/Staging HEAD.
 *  - On remote AND fast-forwardable to origin/Staging → fast-forward.
 *  - On remote AND has non-Staging commits (someone merged a task PR in
 *    already for today) → LEAVE ALONE. Rewriting history would break the
 *    already-open task PRs targeting it. The dispatcher accepts today's
 *    already-in-flight work as-is; freshness matters only for BRAND-NEW
 *    per-day branches.
 */
async function ensureBatchBranch() {
  await execFileP('git', ['fetch', 'origin', 'Staging']);

  if (!(await remoteBranchExists(TODAY_BRANCH))) {
    log.info('dispatch', 'batch-branch-create', { branch: TODAY_BRANCH, from: 'origin/Staging' });
    await execFileP('git', ['checkout', '-B', TODAY_BRANCH, 'origin/Staging']);
    await execFileP('git', ['push', 'origin', TODAY_BRANCH]);
    return;
  }

  // Branch exists. Fast-forward it to origin/Staging IF safe.
  await execFileP('git', ['fetch', 'origin', TODAY_BRANCH]);
  const stagingSha = (await execFileP('git', ['rev-parse', 'origin/Staging'])).stdout.trim();
  const branchSha  = (await execFileP('git', ['rev-parse', `origin/${TODAY_BRANCH}`])).stdout.trim();
  if (stagingSha === branchSha) {
    log.debug('dispatch', 'batch-branch-already-current', { branch: TODAY_BRANCH });
    return;
  }
  // Is origin/Staging an ancestor of origin/<TODAY_BRANCH>? If yes, branch already ahead - leave alone.
  const stagingIsAncestor = await execFileP('git', ['merge-base', '--is-ancestor', 'origin/Staging', `origin/${TODAY_BRANCH}`])
    .then(() => true)
    .catch(() => false);
  if (stagingIsAncestor) {
    log.debug('dispatch', 'batch-branch-ahead-of-staging', { branch: TODAY_BRANCH });
    return;
  }
  // Is origin/<TODAY_BRANCH> an ancestor of origin/Staging? If yes, safe fast-forward.
  const branchIsAncestor = await execFileP('git', ['merge-base', '--is-ancestor', `origin/${TODAY_BRANCH}`, 'origin/Staging'])
    .then(() => true)
    .catch(() => false);
  if (branchIsAncestor) {
    log.info('dispatch', 'batch-branch-fast-forward', {
      branch: TODAY_BRANCH,
      from: branchSha.slice(0, 8),
      to: stagingSha.slice(0, 8),
    });
    // Push origin/Staging's SHA to the batch branch. Fast-forward-only push.
    await execFileP('git', ['push', 'origin', `${stagingSha}:refs/heads/${TODAY_BRANCH}`]);
    return;
  }
  // Diverged. Someone put task-PR merges on TODAY_BRANCH that aren't on Staging.
  // Leave it alone - rewriting would break those open PRs. Log a WARN so an
  // operator notices; drift will be resolved when TODAY_BRANCH promotes to Staging.
  log.warn('dispatch', 'batch-branch-diverged', {
    branch: TODAY_BRANCH,
    branchSha: branchSha.slice(0, 8),
    stagingSha: stagingSha.slice(0, 8),
    note: 'leaving as-is; open task PRs would break if we rewrote. Promote TODAY_BRANCH to Staging soon to resync.',
  });
}

async function existingPullRequest(branch) {
  const { stdout } = await execFileP('gh', [
    'pr', 'list',
    '--repo', REPO,
    '--head', branch,
    '--state', 'open',
    '--json', 'number,url',
    '--limit', '1',
  ]);
  return JSON.parse(stdout || '[]')[0] || null;
}

async function createTaskPullRequest(issue, body) {
  const slug = slugifyTitle(issue.title);
  const branch = `nightshift/${issue.number}-${slug}`;
  await ensureBatchBranch();

  const existing = await existingPullRequest(branch);
  if (existing) {
    const { stdout: commentOut } = await execFileP('gh', [
      'pr', 'comment', String(existing.number),
      '--repo', REPO,
      '--body', body,
    ]);
    return {
      branch,
      prNumber: existing.number,
      prUrl: existing.url,
      commentUrl: commentOut.trim(),
      reused: true,
    };
  }

  await execFileP('git', ['fetch', 'origin', 'Staging']);

  // Companion to ensureBatchBranch's freshness logic (#1168), but for the
  // PER-TICKET branch. Live incident 2026-07-21..23: nightshift/1164-* was
  // left on remote by an earlier failed dispatch (push succeeded, PR create
  // failed, dispatch died). No open PR referenced it, so the reuse branch
  // above didn't fire. Every subsequent day's dispatch tried to push a new
  // "branch from today's origin/Staging" over that stale ref, producing
  // "non-fast-forward" and killing the whole run.
  //
  // Safe deletion rule: if a remote branch by this name exists AND no open
  // PR references it, it is by construction orphaned - no downstream
  // consumer depends on it - and can be force-deleted so the fresh push
  // below is a plain create, not a rewrite.
  if (await remoteBranchExists(branch)) {
    log.warn('dispatch', 'stale-per-ticket-branch-deleting', {
      branch,
      reason: 'no open PR references it; leftover from a failed prior dispatch',
    });
    await execFileP('git', ['push', 'origin', '--delete', branch]);
  }

  await execFileP('git', ['checkout', '-B', branch, 'origin/Staging']);
  await execFileP('git', ['config', 'user.name', 'github-actions[bot]']);
  await execFileP('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  await execFileP('git', ['commit', '--allow-empty', '-m', `chore(night-shift): dispatch issue #${issue.number}`]);
  await execFileP('git', ['push', '-u', 'origin', branch]);

  const prBody = `## Night-shift task

Dispatch issue: ${issue.url}

This draft PR is a Codex subscription connector task surface. The first comment contains the \`@codex\` instructions.`;
  // The next 3 gh calls run immediately after the branch push (above) and
  // are the ones that race with the remote's eventual consistency. Wrapped in
  // execGhWithRetry so we survive transient "No commits between" 5xx / rate-limit.
  const { stdout: prOut } = await execGhWithRetry([
    'pr', 'create',
    '--repo', REPO,
    '--base', TODAY_BRANCH,
    '--head', branch,
    '--draft',
    '--title', `[night-shift] #${issue.number}: ${issue.title}`,
    '--body', prBody,
  ], { label: `pr create #${issue.number}` });
  const prUrl = prOut.trim();
  const { stdout: viewOut } = await execGhWithRetry([
    'pr', 'view', prUrl,
    '--repo', REPO,
    '--json', 'number,url',
  ], { label: `pr view ${prUrl}` });
  const pr = JSON.parse(viewOut);
  const { stdout: commentOut } = await execGhWithRetry([
    'pr', 'comment', String(pr.number),
    '--repo', REPO,
    '--body', body,
  ], { label: `pr comment #${pr.number}` });
  return {
    branch,
    prNumber: pr.number,
    prUrl: pr.url,
    commentUrl: commentOut.trim(),
    reused: false,
  };
}

/**
 * Create a draft PR, post the @codex comment, label the source issue.
 */
async function dispatchTicket(issue) {
  const body = buildCodexPrompt(issue).replace(
    '$(timestamp)',
    new Date().toISOString(),
  );
  const label = `night-shift:dispatched-${TODAY_BRANCH.replace('night-shift-staging-', '')}`;

  if (MODE === 'dry-run') {
    log.info('dispatch', 'DRY-RUN would-dispatch', {
      num: issue.number,
      title: issue.title.slice(0, 60),
      url: issue.url,
      label,
    });
    return { ok: true, dryRun: true };
  }

  try {
    const task = await createTaskPullRequest(issue, body);
    const { stdout: issueCommentOut } = await execFileP('gh', [
      'issue', 'comment', String(issue.number),
      '--repo', REPO,
      '--body', `🌙 Night-shift dispatched to Codex subscription PR: ${task.prUrl}`,
    ]);
    const issueCommentUrl = issueCommentOut.trim();

    const appliedLabel = await applyDispatchLabel(issue);

    log.info('dispatch', 'dispatched', {
      num: issue.number,
      title: issue.title.slice(0, 60),
      prUrl: task.prUrl,
      commentUrl: task.commentUrl,
      label: appliedLabel,
      reused: task.reused,
    });
    return { ok: true, prUrl: task.prUrl, commentUrl: task.commentUrl, issueCommentUrl };
  } catch (err) {
    log.error('dispatch', 'dispatch-failed', {
      num: issue.number,
      error: err.message.slice(0, 300),
    });
    return { ok: false, error: err.message };
  }
}

async function main() {
  let issues = [];
  try {
    issues = await listOpenIssues();
  } catch {
    process.exit(2);
  }

  const { eligible, considered, skipped } = await selectTickets(issues);

  if (eligible.length === 0) {
    log.warn('dispatch', 'no-eligible-tickets', {
      open: issues.length,
      considered: considered.length,
      skipped: skipped.length,
    });
    await notifyTelegram(
      `🌙 Night-shift dispatch: 0 tickets eligible (${issues.length} open, ${skipped.length} filtered, ${considered.length - eligible.length} dropped on preflight).`,
    );
    process.exit(0);
  }

  const results = [];
  for (const issue of eligible) {
    const r = await dispatchTicket(issue);
    results.push({ issue, result: r });
  }

  const successCount = results.filter((r) => r.result.ok).length;
  const failCount = results.length - successCount;

  // Telegram summary
  const lines = [
    `🌙 *Night-shift dispatch* (${MODE === 'dry-run' ? 'DRY-RUN' : 'codex-subscription'})`,
    `Batch: \`${TODAY_BRANCH}\``,
    `Dispatched: ${successCount} / ${results.length}`,
    '',
    ...results.map((r) => {
      const tag = r.result.ok
        ? (r.result.dryRun ? '🧪' : '✅')
        : '❌';
      const url = r.result.prUrl || r.result.commentUrl || r.issue.url;
      return `${tag} #${r.issue.number} - ${r.issue.title.slice(0, 70)}\n  ${url}`;
    }),
  ];
  await notifyTelegram(lines.join('\n'), { parseMode: 'Markdown' });

  if (failCount > 0) {
    log.error('dispatch', 'some-dispatches-failed', { failCount });
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  log.error('dispatch', 'unhandled', err.message);
  process.exit(2);
});
