/**
 * preflight.mjs — director-callable.
 *
 * Two modes:
 *
 * 1. Dry-run / queue listing (no issue#):
 *    `node preflight.mjs --dry-run`
 *    Returns JSON list of candidate tickets: open, classified, deduped.
 *    Used by director's first step + by the user during install for sanity.
 *
 * 2. Per-ticket verify-first check (with issue#):
 *    `node preflight.mjs <issue#>`
 *    Returns { shouldSkip, reason, mergedPR? }.
 *    Used by director before dispatching a worker.
 *
 * "Already done" detection: searches for merged PRs that reference the issue
 * number in title or body, OR scans the issue body for fixed-in-#N patterns.
 * Hit → comment on the issue + label `night-shift:done` + skip.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log, readConfig } from './lib.mjs';
import { classifyIssue } from './classifier.mjs';

const execFileP = promisify(execFile);

// ─── List candidate tickets ────────────────────────────────────────────────

function getRepo() {
  // Allow dry-run to work without ~/.night-shift/config.json. Fall back to
  // the well-known repo if config is missing — the user only needs config to
  // be set up before actual night-shift runs.
  try { return readConfig().repo || 'your-org/your-repo'; }
  catch { return 'your-org/your-repo'; }
}

async function listOpenTickets({ limit = 50 } = {}) {
  const repo = getRepo();
  const { stdout } = await execFileP('gh', [
    'issue', 'list',
    '--repo', repo,
    '--state', 'open',
    '--limit', String(limit),
    '--json', 'number,title,body,labels,createdAt,updatedAt,author',
  ], { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// ─── "Already done" detection ──────────────────────────────────────────────

/**
 * Look for merged PRs that close or reference this issue. Three complementary
 * signals, each capable of vetoing the dispatch on its own:
 *
 *   a) GitHub's native "closing PR" link via the issue API. This is the most
 *      reliable signal — GitHub itself recognises that the PR closed the issue
 *      (because the PR title/body used "Closes #N" / "Fixes #N" / etc.).
 *   b) Text search across PRs that mention #N in title or body, filtered to
 *      merged-state.
 *   c) Author + title pattern: a merged PR titled "fix(area): ... (#N)" is a
 *      strong tell even if (a) misses (the closing-PR linkage requires the
 *      Closes-syntax which not every PR uses).
 *
 * Returns the first match, or null if none. CRITICALLY: if a check ITSELF
 * errors (network, gh CLI changed its schema, etc.), this function returns a
 * sentinel `{ checkErrored: true, reason }` instead of null, so the caller can
 * choose to ERR ON THE SIDE OF SKIPPING rather than dispatching blind. That's
 * the fix for the silent-no-op bug that let #649 (already-merged via PR #650)
 * get dispatched on 2026-06-08.
 */
async function findMergedClosingPR(issueNum) {
  const repo = getRepo();
  let primaryCheckErrored = null;

  // Signal A — GitHub's native closing-PR linkage (most reliable)
  try {
    const { stdout } = await execFileP('gh', [
      'issue', 'view', String(issueNum),
      '--repo', repo,
      '--json', 'closedByPullRequestsReferences',
    ]);
    const data = JSON.parse(stdout || '{}');
    const linked = data?.closedByPullRequestsReferences || [];
    const mergedLink = linked.find((pr) => pr.state === 'MERGED' || pr.state === 'CLOSED');
    if (mergedLink) {
      return {
        signal: 'closedByPullRequestsReferences',
        number: mergedLink.number,
        url: mergedLink.url,
        title: mergedLink.title,
      };
    }
  } catch (err) {
    log('preflight', 'gh-issue-view-failed', { issueNum, error: err.message.slice(0, 200) });
    primaryCheckErrored = `gh issue view failed: ${err.message.slice(0, 120)}`;
  }

  // Signal B — text search for merged PRs that mention #<num>
  // Note: `mergedAt` is NOT a valid --json field for `gh search prs` (we hit
  // this bug on 2026-06-08). Use the documented fields only.
  try {
    const { stdout } = await execFileP('gh', [
      'search', 'prs',
      '--repo', repo,
      '--state', 'closed',
      '--merged',
      String(issueNum),
      '--json', 'number,title,url,state,closedAt',
      '--limit', '5',
    ], { maxBuffer: 1 * 1024 * 1024 });
    const prs = JSON.parse(stdout || '[]');
    // Match either:
    //  - "#<num>" appears in PR title (e.g. "fix(area): ... (#649)")
    //  - "closes/fixes #<num>" pattern in title
    const matches = prs.filter((pr) => {
      const t = (pr.title || '');
      return new RegExp(`(?:\\(|\\b)#${issueNum}\\b`).test(t) ||
             new RegExp(`(closes|fixes|resolves)\\s+#${issueNum}\\b`, 'i').test(t);
    });
    if (matches.length > 0) {
      return {
        signal: 'merged-pr-text-search',
        number: matches[0].number,
        url: matches[0].url,
        title: matches[0].title,
      };
    }
  } catch (err) {
    log('preflight', 'gh-search-failed', { issueNum, error: err.message.slice(0, 200) });
    // If BOTH checks errored, surface that to the caller — fail loud, not silent
    if (primaryCheckErrored) {
      return {
        checkErrored: true,
        reason: `both verify-first checks failed: (a) ${primaryCheckErrored} (b) gh search failed: ${err.message.slice(0, 120)}`,
      };
    }
  }

  return null;
}

async function scanBodyForClosingRef(issueBody) {
  if (!issueBody) return null;
  // Match: "closed by #N", "fixed in PR #N", "addressed by #N", etc.
  const m = issueBody.match(/\b(closed|fixed|completed|addressed|resolved|merged)\s+(by|in)\s+(?:pr\s*)?#?(\d+)/i);
  if (m) return { matchedPattern: m[0], referencedPR: m[3] };
  return null;
}

// ─── Per-ticket verify-first ───────────────────────────────────────────────

export async function verifyFirst(issueNum) {
  const repo = getRepo();

  // Fetch full issue
  const { stdout } = await execFileP('gh', [
    'issue', 'view', String(issueNum),
    '--repo', repo,
    '--json', 'number,title,body,labels,state',
  ]);
  const issue = JSON.parse(stdout);

  if (issue.state !== 'OPEN') {
    return { shouldSkip: true, reason: `issue state is ${issue.state}`, issueNum };
  }

  // 1. Look for merged PRs referencing this issue
  const mergedPR = await findMergedClosingPR(issueNum);
  if (mergedPR) {
    // The check ITSELF errored — refuse to dispatch (err on the side of
    // skipping). This is the explicit fix for the silent-no-op bug that let
    // already-merged tickets through on 2026-06-08.
    if (mergedPR.checkErrored) {
      return {
        shouldSkip: true,
        reason: `verify-first check could not run: ${mergedPR.reason}`,
        checkErrored: true,
        issueNum,
      };
    }
    return {
      shouldSkip: true,
      reason: `merged PR #${mergedPR.number} references this issue (signal: ${mergedPR.signal})`,
      mergedPR: mergedPR.url,
      mergedPRTitle: mergedPR.title,
      issueNum,
    };
  }

  // 2. Scan body for in-text "fixed by #N" references
  const bodyRef = await scanBodyForClosingRef(issue.body);
  if (bodyRef) {
    return {
      shouldSkip: true,
      reason: `issue body says "${bodyRef.matchedPattern}" — likely already done`,
      referencedPR: bodyRef.referencedPR,
      issueNum,
    };
  }

  // 3. Apply classifier
  const cls = classifyIssue(issue);
  if (cls.verdict === 'unsafe' || cls.verdict === 'in-progress' || cls.verdict === 'vague') {
    return {
      shouldSkip: true,
      reason: `classifier verdict=${cls.verdict}: ${cls.reasons.join('; ')}`,
      verdict: cls.verdict,
      issueNum,
    };
  }

  return {
    shouldSkip: false,
    reason: 'passes all gates',
    verdict: cls.verdict,
    issueNum,
  };
}

// ─── CLI entry point ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--dry-run') || args.length === 0) {
      // List candidates
      const tickets = await listOpenTickets({ limit: 50 });
      const enriched = tickets.map((t) => {
        const cls = classifyIssue(t);
        return {
          number: t.number,
          title: t.title,
          author: t.author?.login,
          verdict: cls.verdict,
          reasons: cls.reasons,
        };
      });
      const safe = enriched.filter((t) => t.verdict === 'safe');
      const unsafe = enriched.filter((t) => t.verdict === 'unsafe');
      const vague = enriched.filter((t) => t.verdict === 'vague');
      const verifyFirst = enriched.filter((t) => t.verdict === 'verify-first');
      const inProgress = enriched.filter((t) => t.verdict === 'in-progress');
      process.stdout.write(JSON.stringify({
        totalOpen: tickets.length,
        counts: {
          safe: safe.length,
          unsafe: unsafe.length,
          vague: vague.length,
          'verify-first': verifyFirst.length,
          'in-progress': inProgress.length,
        },
        safe: safe.map((t) => ({ number: t.number, title: t.title, author: t.author })),
        verifyFirst: verifyFirst.map((t) => ({ number: t.number, title: t.title, reasons: t.reasons })),
      }, null, 2) + '\n');
    } else {
      const issueNum = args[0];
      const result = await verifyFirst(issueNum);
      log('preflight', 'verify-first', result);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
  } catch (err) {
    log('preflight', 'error', { args, error: err.message });
    process.stderr.write(`preflight.mjs error: ${err.message}\n`);
    process.exit(1);
  }
}

import url from 'node:url';
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main();
}
