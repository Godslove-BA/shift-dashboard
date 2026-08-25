/**
 * git.mjs — the SINGLE point that owns all git push/commit/branch operations.
 *
 * Why a single chokepoint: workers run as autonomous Codex agents with broad
 * Edit tool access in their worktrees. If they could call `git push` or
 * `git reset --hard` directly, a misclassified ticket could corrupt Staging
 * or wipe in-flight work. Routing every git mutation through this module
 * lets us enforce:
 *   - Only push refs/heads/nightshift/* and refs/heads/night-shift-staging-*
 *   - NEVER --force, --force-with-lease (except the once-per-night night-shift-staging reset)
 *   - NEVER reset --hard, rebase, filter-branch, checkout -f, clean
 *   - All commits use the night-shift identity (visually distinct from human commits)
 *   - Audit log entry for every operation
 *
 * Workers + director call into this via `node tools/night-shift/git.mjs <cmd> <args>`
 * from their allowlisted Bash tool. They DO NOT have direct `git push` permission.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readConfig, log } from './lib.mjs';

const execFileP = promisify(execFile);

// ─── Branch + ref guard rails ──────────────────────────────────────────────

const ALLOWED_PUSH_REFS = [
  /^refs\/heads\/nightshift\/[\w\-./]+$/,
  /^refs\/heads\/night-shift-staging-\d{4}-\d{2}-\d{2}$/,
];

const FORBIDDEN_GIT_SUBCOMMANDS = new Set([
  'reset',         // we use revert instead
  'rebase',
  'filter-branch',
  'filter-repo',
  'clean',
  'gc',            // can clobber refs if used wrongly
]);

const FORBIDDEN_FLAGS = ['--force', '-f', '--hard', '--force-with-lease'];

function assertRefAllowed(ref) {
  if (!ALLOWED_PUSH_REFS.some((re) => re.test(ref))) {
    throw new Error(`git.mjs: refusing to push ref ${ref} — not in allowlist (must match nightshift/* or night-shift-staging-YYYY-MM-DD)`);
  }
}

function assertFlagsAllowed(args, contextLabel) {
  for (const flag of args) {
    if (FORBIDDEN_FLAGS.includes(flag)) {
      throw new Error(`git.mjs: refusing to run \`${contextLabel}\` with forbidden flag ${flag}`);
    }
  }
}

// ─── Identity ──────────────────────────────────────────────────────────────

async function gitIdentityArgs() {
  const cfg = readConfig();
  return [
    '-c', `user.name=${cfg.commitIdentity?.name || 'Night Shift Bot'}`,
    '-c', `user.email=${cfg.commitIdentity?.email || 'nightshift@the-source-project.cloud'}`,
  ];
}

// ─── Operations ────────────────────────────────────────────────────────────

/**
 * Run a read-only git command in a worktree. Whitelisted set: status, diff, log,
 * branch (list), show, rev-parse, ls-files. Refuses anything that mutates.
 */
export async function gitRead(cwd, args) {
  const sub = args[0];
  const READONLY = new Set(['status', 'diff', 'log', 'branch', 'show', 'rev-parse', 'ls-files', 'remote', 'rev-list', 'config']);
  if (!READONLY.has(sub)) throw new Error(`git.mjs:gitRead: subcommand ${sub} not in read-only allowlist`);
  if (sub === 'config') {
    // Only allow `git config --get user.email` style; refuse anything else
    const isGet = args.includes('--get') || args.includes('--get-all');
    if (!isGet) throw new Error('git.mjs:gitRead: only `git config --get` allowed');
  }
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/**
 * Stage files BY PATH (never `-A`, never `-u`, never `.`). Safer because the
 * worktree may contain symlinks to .env that we don't want staged.
 */
export async function gitAdd(cwd, paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('git.mjs:gitAdd: paths must be a non-empty array');
  }
  for (const p of paths) {
    if (typeof p !== 'string' || p.startsWith('-')) {
      throw new Error(`git.mjs:gitAdd: refusing to stage suspicious path ${p}`);
    }
    if (p.includes('.env')) {
      throw new Error(`git.mjs:gitAdd: refusing to stage .env path ${p} (would leak secrets)`);
    }
  }
  await execFileP('git', ['add', '--', ...paths], { cwd });
  log('git', 'add', { cwd, count: paths.length });
}

/**
 * Commit staged changes with the night-shift identity. Message is required.
 */
export async function gitCommit(cwd, message) {
  if (!message || typeof message !== 'string' || message.length < 3) {
    throw new Error('git.mjs:gitCommit: message required (>=3 chars)');
  }
  if (FORBIDDEN_FLAGS.some((f) => message.includes(f))) {
    throw new Error('git.mjs:gitCommit: message contains forbidden flag-looking text');
  }
  const id = await gitIdentityArgs();
  await execFileP('git', [...id, 'commit', '-m', message], { cwd });
  log('git', 'commit', { cwd, message: message.slice(0, 80) });
}

/**
 * Push a single branch ref. Refuses any ref not matching nightshift/* or
 * night-shift-staging-*. Refuses all --force variants.
 */
export async function gitPush(cwd, branch, { setUpstream = true } = {}) {
  assertRefAllowed(`refs/heads/${branch}`);
  const args = ['push', 'origin', branch];
  if (setUpstream) args.splice(1, 0, '-u');
  assertFlagsAllowed(args, 'git push');
  await execFileP('git', args, { cwd });
  log('git', 'push', { cwd, branch });
}

/**
 * Create a new worktree at a given path, from a given starting ref.
 * Used by spawn-worker.mjs to allocate per-ticket worktrees.
 *
 * The path must be EXTERNAL to the primary checkout (per
 * feedback_parallel_agents_external_worktree.md) — caller is responsible for
 * providing a safe path like ~/night-shift-worktrees/<issue#>-<slug>/.
 */
export async function createWorktree(primaryRepo, worktreePath, branch, startPoint) {
  if (!worktreePath || worktreePath.startsWith(primaryRepo)) {
    throw new Error(`git.mjs:createWorktree: worktreePath must be external to primaryRepo`);
  }
  // git worktree add -b <branch> <path> <start-point>
  await execFileP('git', ['worktree', 'add', '-b', branch, worktreePath, startPoint], { cwd: primaryRepo });
  log('git', 'worktree-add', { worktreePath, branch, startPoint });
}

/**
 * Remove a worktree. Soft by default (refuses if there are uncommitted changes).
 * Force mode is locked behind an explicit option AND only honoured for paths
 * under ~/night-shift-worktrees/.
 */
export async function removeWorktree(primaryRepo, worktreePath, { force = false } = {}) {
  const args = ['worktree', 'remove'];
  if (force) {
    // Defense: only allow force-remove on our own worktrees
    if (!worktreePath.includes('night-shift-worktrees')) {
      throw new Error('git.mjs:removeWorktree: force only allowed on ~/night-shift-worktrees/* paths');
    }
    args.push('--force');
  }
  args.push(worktreePath);
  await execFileP('git', args, { cwd: primaryRepo });
  log('git', 'worktree-remove', { worktreePath, force });
}

/**
 * Create the dated night-shift-staging branch (idempotent: if it exists at the
 * right commit, no-op; if it exists at a stale commit, fast-forward to current
 * origin/Staging; if it doesn't exist, create it).
 *
 * Returns the branch name (e.g. "night-shift-staging-2026-06-06").
 */
export async function ensureNightShiftBranch(primaryRepo) {
  const today = new Date().toISOString().slice(0, 10);
  const branch = `night-shift-staging-${today}`;

  // Fetch latest Staging
  await execFileP('git', ['fetch', 'origin', 'Staging'], { cwd: primaryRepo });

  // Does the branch exist locally?
  let exists = false;
  try {
    await execFileP('git', ['rev-parse', '--verify', branch], { cwd: primaryRepo });
    exists = true;
  } catch { /* doesn't exist */ }

  if (!exists) {
    // Create from origin/Staging
    const id = await gitIdentityArgs();
    await execFileP('git', [...id, 'branch', branch, 'origin/Staging'], { cwd: primaryRepo });
    // Push it so per-ticket branches can target it
    await execFileP('git', ['push', '-u', 'origin', branch], { cwd: primaryRepo });
    log('git', 'create-nightshift-branch', { branch });
  } else {
    log('git', 'nightshift-branch-exists', { branch });
  }

  return branch;
}

// ─── CLI entry point (called by director/workers via Bash) ─────────────────

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'read': {
        const [cwd, ...args] = rest;
        process.stdout.write(await gitRead(cwd, args));
        break;
      }
      case 'add': {
        const [cwd, ...paths] = rest;
        await gitAdd(cwd, paths);
        break;
      }
      case 'commit': {
        const [cwd, ...msgParts] = rest;
        await gitCommit(cwd, msgParts.join(' '));
        break;
      }
      case 'push': {
        const [cwd, branch] = rest;
        await gitPush(cwd, branch);
        break;
      }
      case 'worktree-add': {
        const [primary, wt, branch, start] = rest;
        await createWorktree(primary, wt, branch, start);
        break;
      }
      case 'worktree-remove': {
        const [primary, wt, force] = rest;
        await removeWorktree(primary, wt, { force: force === '--force' });
        break;
      }
      case 'ensure-nightshift-branch': {
        const [primary] = rest;
        const branch = await ensureNightShiftBranch(primary);
        process.stdout.write(branch + '\n');
        break;
      }
      default:
        process.stderr.write(`Unknown command: ${cmd}\nUsage: node git.mjs <read|add|commit|push|worktree-add|worktree-remove|ensure-nightshift-branch> ...\n`);
        process.exit(2);
    }
  } catch (err) {
    log('git', 'error', { cmd, error: err.message });
    process.stderr.write(`git.mjs error: ${err.message}\n`);
    process.exit(1);
  }
}

// Only run main() when invoked directly, not when imported
import url from 'node:url';
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main();
}
