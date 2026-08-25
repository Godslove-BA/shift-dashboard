/**
 * git.mjs — the SINGLE chokepoint that owns all git mutations for DAY SHIFT.
 *
 * Forked from tools/night-shift/git.mjs with day-shift ref allowlists. Kept
 * fully separate (not extending night-shift's module) so the two systems can
 * evolve independently and never collide — night-shift v2 is in flight on
 * another branch.
 *
 * The local worker runs `claude -p --dangerously-skip-permissions`, which means
 * it CAN call `git push` / `git reset --hard` directly inside its worktree.
 * The containment model is:
 *   - The worker prompt forbids pushing/PRs (it only edits + commits locally).
 *   - This module is what dispatch/worker.mjs uses for every push, and it
 *     ONLY permits `dayshift/*` and `day-shift-staging-*` refs, never --force,
 *     never reset --hard. So even if a worker freelances, nothing reaches
 *     Staging/main and nothing force-overwrites a sibling session's branch.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig, log } from './lib.mjs';

const execFileP = promisify(execFile);

// ─── Branch + ref guard rails ──────────────────────────────────────────────

const ALLOWED_PUSH_REFS = [
  /^refs\/heads\/dayshift\/[\w\-./]+$/,
  /^refs\/heads\/day-shift-staging-\d{4}-\d{2}-\d{2}$/,
];

const FORBIDDEN_FLAGS = ['--force', '-f', '--hard', '--force-with-lease'];

function assertRefAllowed(ref) {
  if (!ALLOWED_PUSH_REFS.some((re) => re.test(ref))) {
    throw new Error(
      `git.mjs: refusing to push ref ${ref} — not in allowlist (must match dayshift/* or day-shift-staging-YYYY-MM-DD)`,
    );
  }
}

function assertFlagsAllowed(args, contextLabel) {
  for (const flag of args) {
    if (FORBIDDEN_FLAGS.includes(flag)) {
      throw new Error(`git.mjs: refusing to run \`${contextLabel}\` with forbidden flag ${flag}`);
    }
  }
}

async function gitIdentityArgs() {
  const cfg = readConfig();
  return [
    '-c', `user.name=${cfg.commitIdentity?.name || 'Day Shift Bot'}`,
    '-c', `user.email=${cfg.commitIdentity?.email || 'dayshift@the-source-project.cloud'}`,
  ];
}

// ─── Operations ────────────────────────────────────────────────────────────

/** Read-only git in a worktree. Refuses anything that mutates. */
export async function gitRead(cwd, args) {
  const sub = args[0];
  const READONLY = new Set(['status', 'diff', 'log', 'branch', 'show', 'rev-parse', 'ls-files', 'remote', 'rev-list', 'config']);
  if (!READONLY.has(sub)) throw new Error(`git.mjs:gitRead: subcommand ${sub} not in read-only allowlist`);
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/**
 * Create a NEW worktree at an external path, branched `dayshift/<...>` from a
 * start point (origin/Staging). Refuses paths inside the primary checkout.
 */
export async function createWorktree(primaryRepo, worktreePath, branch, startPoint) {
  if (!worktreePath || worktreePath.startsWith(primaryRepo)) {
    throw new Error('git.mjs:createWorktree: worktreePath must be external to primaryRepo');
  }
  assertRefAllowed(`refs/heads/${branch}`);

  // Self-heal stale state from a prior CRASHED run. `git worktree remove` deletes
  // the worktree but NOT its branch, so a run that died after `worktree add`
  // leaves an orphaned `dayshift/<issue>-*` branch behind. On the next attempt
  // `worktree add -b` then fails with "a branch named '<branch>' already exists"
  // — and because that throws BEFORE worker.mjs's try/finally, the ticket is
  // never labeled and gets re-picked forever (10+ hrs of wasted runs on #840 is
  // exactly how this surfaced). Clean the slate first. Scoped strictly to
  // dayshift/* (assertRefAllowed already guaranteed the prefix) so this can never
  // touch a human's or sibling session's branch.
  await execFileP('git', ['worktree', 'prune'], { cwd: primaryRepo }).catch(() => {});
  // Drop a dangling worktree registration at this exact path, if any.
  await execFileP('git', ['worktree', 'remove', '--force', worktreePath], { cwd: primaryRepo }).catch(() => {});
  // Delete an orphaned local branch of the same name so `-b` can recreate it.
  let orphanExists = false;
  try {
    await execFileP('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: primaryRepo });
    orphanExists = true;
  } catch { /* no local branch — nothing to clean */ }
  if (orphanExists) {
    // Warn (don't block) if the orphan carried un-pushed commits — its worktree
    // is already gone, so those commits are unrecoverable regardless; a fresh
    // attempt from startPoint is the only forward path.
    let ahead = 0;
    try {
      const { stdout } = await execFileP('git', ['rev-list', '--count', `${startPoint}..${branch}`], { cwd: primaryRepo });
      ahead = Number(stdout.trim()) || 0;
    } catch { /* best effort */ }
    await execFileP('git', ['branch', '-D', branch], { cwd: primaryRepo });
    log('git', 'pruned-orphan-branch', { branch, hadCommits: ahead });
  }

  await execFileP('git', ['worktree', 'add', '-b', branch, worktreePath, startPoint], { cwd: primaryRepo });
  log('git', 'worktree-add', { worktreePath, branch, startPoint });
}

/**
 * Remove a worktree. Force-remove only honoured for paths under
 * day-shift-worktrees (defense against nuking a human's worktree).
 */
export async function removeWorktree(primaryRepo, worktreePath, { force = false } = {}) {
  const args = ['worktree', 'remove'];
  if (force) {
    if (!worktreePath.includes('day-shift-worktrees')) {
      throw new Error('git.mjs:removeWorktree: force only allowed on day-shift-worktrees/* paths');
    }
    args.push('--force');
  }
  args.push(worktreePath);
  await execFileP('git', args, { cwd: primaryRepo });
  log('git', 'worktree-remove', { worktreePath, force });
}

/** Push a single allowlisted branch ref. Refuses everything else + all --force. */
export async function gitPush(cwd, branch, { setUpstream = true } = {}) {
  assertRefAllowed(`refs/heads/${branch}`);
  const args = ['push', 'origin', branch];
  if (setUpstream) args.splice(1, 0, '-u');
  assertFlagsAllowed(args, 'git push');
  await execFileP('git', args, { cwd });
  log('git', 'push', { cwd, branch });
}

/**
 * Ensure today's holding branch exists on origin (idempotent). Created from
 * origin/<baseBranch> (Staging). Returns the branch name. Per-ticket
 * dayshift/* branches and the eventual draft PR target this.
 */
export async function ensureHoldingBranch(primaryRepo, baseBranch = 'Staging') {
  const today = new Date().toISOString().slice(0, 10);
  const branch = `day-shift-staging-${today}`;
  assertRefAllowed(`refs/heads/${branch}`);

  await execFileP('git', ['fetch', 'origin', baseBranch], { cwd: primaryRepo });

  // Already on origin?
  let existsRemote = false;
  try {
    await execFileP('git', ['rev-parse', '--verify', `origin/${branch}`], { cwd: primaryRepo });
    existsRemote = true;
  } catch { /* not yet */ }

  if (!existsRemote) {
    const id = await gitIdentityArgs();
    // Create local ref at origin/<base>, then push it up.
    try {
      await execFileP('git', [...id, 'branch', branch, `origin/${baseBranch}`], { cwd: primaryRepo });
    } catch {
      // Local branch may already exist; fine.
    }
    await execFileP('git', ['push', '-u', 'origin', branch], { cwd: primaryRepo });
    log('git', 'create-holding-branch', { branch, from: `origin/${baseBranch}` });
  } else {
    // Keep the holding branch current with Staging when it is SAFE to do so:
    // a clean fast-forward, only when holding is an ancestor of origin/<base>
    // (i.e. all previously-folded work has already been promoted, so holding
    // has no un-promoted divergence). This prevents the base-staleness that
    // makes per-ticket PR diffs show the whole Staging delta as noise. If
    // holding HAS diverged (unpromoted folded PRs), we leave it — the next
    // promote reconciles it, and worktrees branch from holding anyway.
    let isAncestor = false;
    try {
      await execFileP('git', ['merge-base', '--is-ancestor', `origin/${branch}`, `origin/${baseBranch}`], { cwd: primaryRepo });
      isAncestor = true;
    } catch { /* diverged — not fast-forwardable */ }
    if (isAncestor) {
      try {
        // Non-force fast-forward of the remote holding ref up to origin/<base>.
        await execFileP('git', ['push', 'origin', `origin/${baseBranch}:refs/heads/${branch}`], { cwd: primaryRepo });
        log('git', 'holding-branch-fast-forwarded', { branch, to: `origin/${baseBranch}` });
      } catch (err) {
        log('git', 'holding-ff-skipped', { branch, error: err.message.slice(0, 120) });
      }
    } else {
      // Holding has DIVERGED from Staging (un-promoted folded PRs sit on it, so
      // it's no longer a fast-forward). Left alone, it goes stale against Staging
      // — and because per-ticket worktrees branch from holding, a new ticket
      // inherits holding's OLD workflow/CI files. That is exactly what made a
      // ticket run CI on retired `ubuntu-latest` runners (billing-failed) after
      // Staging had already migrated to ubicloud. Cure: merge current Staging
      // INTO holding (preserving the folded PRs) so holding tracks Staging's
      // workflow files + everything else. Done with pure plumbing — no checkout,
      // no working tree — and pushed non-force as a fast-forward (the merge
      // commit's FIRST parent is the current holding tip). Abort on conflict and
      // leave holding untouched; the eventual promote reconciles it.
      try {
        const { stdout: treeOut } = await execFileP(
          'git',
          ['merge-tree', '--write-tree', `origin/${branch}`, `origin/${baseBranch}`],
          { cwd: primaryRepo },
        );
        const mergedTree = treeOut.trim().split('\n')[0];
        const id = await gitIdentityArgs();
        const { stdout: commitOut } = await execFileP(
          'git',
          [
            ...id,
            'commit-tree', mergedTree,
            '-p', `origin/${branch}`,
            '-p', `origin/${baseBranch}`,
            '-m', `chore(day-shift): merge ${baseBranch} into ${branch} to keep CI/workflow files current`,
          ],
          { cwd: primaryRepo },
        );
        const mergeCommit = commitOut.trim();
        // First parent is origin/<branch>, so this push is a clean fast-forward.
        await execFileP('git', ['push', 'origin', `${mergeCommit}:refs/heads/${branch}`], { cwd: primaryRepo });
        log('git', 'holding-branch-merged-base', { branch, base: baseBranch, mergeCommit });
      } catch (err) {
        // merge-tree exits non-zero on conflict → skip (promote reconciles it).
        log('git', 'holding-merge-skipped', { branch, error: err.message.slice(0, 160) });
      }
    }
  }
  return branch;
}

// ─── CLI entry point (optional manual use) ─────────────────────────────────

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'ensure-holding-branch': {
        const [primary, base] = rest;
        const branch = await ensureHoldingBranch(primary || process.cwd(), base || 'Staging');
        process.stdout.write(branch + '\n');
        break;
      }
      case 'push': {
        const [cwd, branch] = rest;
        await gitPush(cwd, branch);
        break;
      }
      default:
        process.stderr.write('Usage: node git.mjs <ensure-holding-branch|push> ...\n');
        process.exit(2);
    }
  } catch (err) {
    log('git', 'error', { cmd, error: err.message });
    process.stderr.write(`git.mjs error: ${err.message}\n`);
    process.exit(1);
  }
}

import url from 'node:url';
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main();
}
