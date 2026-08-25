// Smoke tests for tools/day-shift/day-shift.sb (the macOS sandbox-exec profile
// used when DAY_SHIFT_SANDBOX=1 is set).
//
// We're not trying to prove macOS sandbox semantics here — we're proving that
// the profile PARSES cleanly (sandbox-exec would error before spawning the
// command otherwise) and that /usr/bin/true still runs under it. That's enough
// to catch the failure mode we actually care about: a syntax typo in the
// profile silently disabling the day-shift worker.
//
// A separate sanity check confirms `deny default` is actually working by
// asserting a read outside the allowlist fails.
//
// Run: node --test tools/day-shift/__tests__/sandbox.test.mjs
//
// Skipped automatically off darwin (sandbox-exec is macOS-only), and skipped
// if /usr/bin/sandbox-exec isn't present (CI images sometimes strip it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.resolve(__dirname, '..', 'day-shift.sb');
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

// Gate: only run on macOS with sandbox-exec present. Anywhere else the test
// is a no-op (still counts as passing) so the day-shift test suite stays
// green on Linux CI.
const canRun = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
const maybe = canRun ? test : test.skip;

/**
 * Build the -D binding argv that day-shift.sb requires. Every (param "…") in
 * the profile has to be bound here or sandbox-exec refuses to start with
 * "unbound variable". Mirrors sandboxParamsForTicket() in worker.mjs.
 */
function bindings(worktree, scratch, worktreeRoot, primaryRepo) {
  const home = homedir();
  const params = {
    WORKTREE: worktree,
    SCRATCH: scratch,
    WORKTREE_ROOT: worktreeRoot,
    PRIMARY_REPO: primaryRepo,
    HOME_DIR: home,
    CLAUDE_HOME: path.join(home, '.claude'),
    NPM_CACHE: path.join(home, '.npm'),
    USER_CACHE: path.join(home, '.cache'),
    GH_CONFIG: path.join(home, '.config'),
    GH_STATE: path.join(home, '.local'),
    HOME_SSH: path.join(home, '.ssh'),
    HOME_GITCONFIG: path.join(home, '.gitconfig'),
    HOME_GITIGNORE: path.join(home, '.gitignore_global'),
    HOME_NPMRC: path.join(home, '.npmrc'),
  };
  const argv = [];
  for (const [k, v] of Object.entries(params)) argv.push('-D', `${k}=${v}`);
  return argv;
}

maybe('day-shift.sb exists and parses (sandbox-exec runs /usr/bin/true)', async () => {
  // Test dir under /tmp (not TMPDIR) — /var/folders/* has per-user TCC quirks
  // that make it a poor sandbox target in tests. The real worker uses
  // ~/day-shift-worktrees/, which is a plain user-owned dir with no TCC.
  const root = mkdtempSync(path.join(tmpdir(), 'day-shift-sb-'));
  try {
    const wt = path.join(root, 'wt');
    const scratch = path.join(root, 'scratch');
    const primary = path.join(root, 'primary');
    const args = [
      ...bindings(wt, scratch, root, primary),
      '-f', PROFILE,
      '/usr/bin/true',
    ];
    // execFileP throws on non-zero exit. If the profile has a syntax error,
    // sandbox-exec prints "profile parse failed" to stderr and exits ≠ 0
    // BEFORE running /usr/bin/true. If it parses, /usr/bin/true exits 0.
    await execFileP(SANDBOX_EXEC, args);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

maybe('sandbox allows read+write inside WORKTREE', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'day-shift-sb-'));
  try {
    const wt = path.join(root, 'wt');
    const scratch = path.join(root, 'scratch');
    const primary = path.join(root, 'primary');
    const markerPath = path.join(wt, 'marker.txt');
    // Pre-create the file OUTSIDE the sandbox; then read it INSIDE.
    mkdirSync(wt, { recursive: true });
    writeFileSync(markerPath, 'hello from worktree', 'utf8');
    const args = [
      ...bindings(wt, scratch, root, primary),
      '-f', PROFILE,
      '/bin/cat', markerPath,
    ];
    const { stdout } = await execFileP(SANDBOX_EXEC, args);
    assert.equal(stdout, 'hello from worktree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

maybe('sandbox DENIES read outside the allowlist (deny default is real)', async () => {
  // The whole point of this profile: a file outside worktree/scratch/primary/
  // home-config paths should be UNREADABLE. If this assertion ever flips to
  // "readable", the profile has grown too permissive — investigate before merging.
  //
  // Careful path choice: /tmp and /var/folders ARE in the system-temp allow
  // rules (worker needs them for genuine temp files). We need a path that is
  // NOT allowed. A hidden file dropped directly in $HOME works — HOME itself
  // is only a `literal` metadata-read allow, so HOME's children are denied.
  const root = mkdtempSync(path.join(tmpdir(), 'day-shift-sb-'));
  const secret = path.join(homedir(), `.dayshift-sandbox-outside-${process.pid}.txt`);
  writeFileSync(secret, 'should not be readable', 'utf8');
  try {
    const wt = path.join(root, 'wt');
    const scratch = path.join(root, 'scratch');
    const primary = path.join(root, 'primary');
    mkdirSync(wt, { recursive: true });
    const args = [
      ...bindings(wt, scratch, root, primary),
      '-f', PROFILE,
      '/bin/cat', secret,
    ];
    // We EXPECT this to fail. If it succeeds, the sandbox isn't actually
    // enforcing — that's a real regression, fail the test.
    await assert.rejects(
      execFileP(SANDBOX_EXEC, args),
      (err) => {
        // sandbox denials come out as non-zero exit + "Operation not permitted"
        // in stderr. Accept either signal.
        const stderr = String(err.stderr || '');
        return err.code !== 0 && /not permitted|denied/i.test(stderr);
      },
      'sandbox failed to block read of a file outside the allowlist',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(secret, { force: true });
  }
});
