/**
 * verify.mjs — worker-callable verification runner.
 *
 * Called by the worker between Ralph iterations to check whether the most
 * recent edit pass produces green types + green tests. Returns a structured
 * verdict the worker writes into progress.txt.
 *
 * Runs:
 *   1. `npm run typecheck` (project convention)
 *   2. `npm test -- --run <touched-paths>` if touched-paths provided, else full
 *   3. Optional `npm run lint` (worker decides whether to gate on it)
 *
 * UI verification (Playwright walks) is NOT done here — workers call
 * Playwright MCP directly from within the Codex iteration. This module is
 * for pure shell-runnable checks.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './lib.mjs';

const execFileP = promisify(execFile);

const STEP_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per step

async function runStep(label, cmd, args, cwd) {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      timeout: STEP_TIMEOUT_MS,
    });
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    log('verify', `${label}-pass`, { cwd, elapsedSec });
    return {
      step: label,
      pass: true,
      elapsedSec: Number(elapsedSec),
      output: (stdout + stderr).slice(-2000),
    };
  } catch (err) {
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    log('verify', `${label}-fail`, { cwd, elapsedSec, code: err.code });
    return {
      step: label,
      pass: false,
      elapsedSec: Number(elapsedSec),
      code: err.code,
      output: ((err.stdout || '') + (err.stderr || '')).slice(-2000),
    };
  }
}

export async function runVerification(worktreePath, { touchedPaths = [], skipLint = false } = {}) {
  const results = [];

  // 1. Typecheck — always
  const tc = await runStep('typecheck', 'npm', ['run', 'typecheck'], worktreePath);
  results.push(tc);
  if (!tc.pass) {
    return { allPassed: false, firstFailure: 'typecheck', results };
  }

  // 2. Tests — targeted if touched paths provided, otherwise full
  const testArgs = ['test'];
  if (touchedPaths.length > 0) {
    testArgs.push('--', '--run', ...touchedPaths);
  } else {
    testArgs.push('--', '--run');
  }
  const tests = await runStep('test', 'npm', testArgs, worktreePath);
  results.push(tests);
  if (!tests.pass) {
    return { allPassed: false, firstFailure: 'test', results };
  }

  // 3. Lint — optional. the project's staging-ci.yml has lint warnings but no
  //    blocking. Worker can choose to gate on it for stricter PRs.
  if (!skipLint) {
    const lint = await runStep('lint', 'npm', ['run', 'lint'], worktreePath);
    results.push(lint);
    if (!lint.pass) {
      // Non-blocking — still report but don't mark allPassed=false
      log('verify', 'lint-warnings', { worktreePath });
    }
  }

  return { allPassed: true, results };
}

// ─── CLI entry point ───────────────────────────────────────────────────────

async function main() {
  // Usage: node verify.mjs <worktree-path> [--paths <p1> <p2> ...] [--no-lint]
  const args = process.argv.slice(2);
  const worktree = args[0];
  if (!worktree) {
    process.stderr.write('Usage: node verify.mjs <worktree-path> [--paths p1 p2 ...] [--no-lint]\n');
    process.exit(2);
  }
  const pathsIdx = args.indexOf('--paths');
  const touchedPaths = pathsIdx >= 0
    ? args.slice(pathsIdx + 1).filter((a) => !a.startsWith('--'))
    : [];
  const skipLint = args.includes('--no-lint');

  try {
    const result = await runVerification(worktree, { touchedPaths, skipLint });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.allPassed ? 0 : 1);
  } catch (err) {
    log('verify', 'error', { error: err.message });
    process.stderr.write(`verify.mjs error: ${err.message}\n`);
    process.exit(2);
  }
}

import url from 'node:url';
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main();
}
