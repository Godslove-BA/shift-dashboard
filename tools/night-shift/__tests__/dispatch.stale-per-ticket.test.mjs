// Guards the per-ticket-branch freshness fix that companions #1168.
//
// Live incident 2026-07-21..23: nightshift/1164-* was left on remote by an
// earlier failed dispatch (push OK, PR create failed, dispatch died). No open
// PR referenced it, so createTaskPullRequest's reuse branch didn't fire.
// Every subsequent day's dispatch then tried to push a "fresh from today's
// origin/Staging" branch over the stale ref -> non-fast-forward -> whole run
// died. Three scheduled runs (Jul 21/22/23) failed for this reason.
//
// This test is a source-of-truth check: it asserts createTaskPullRequest
// contains the "delete stale per-ticket branch before push" block and that
// the block happens BEFORE the git push line. If the fix ever gets refactored
// out, this test fails loudly.
//
// Run with: node --test tools/night-shift/__tests__/dispatch.stale-per-ticket.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dispatchSrc = readFileSync(join(__dirname, '..', 'dispatch.mjs'), 'utf8');

test('createTaskPullRequest deletes stale per-ticket branch before pushing', () => {
  const fn = extractFunction(dispatchSrc, 'createTaskPullRequest');
  assert.ok(fn, 'createTaskPullRequest function present in dispatch.mjs');

  // Both the guard call and the delete must be present.
  assert.match(fn, /remoteBranchExists\(branch\)/, 'checks remote branch existence for the per-ticket branch');
  assert.match(fn, /push', 'origin', '--delete', branch/, 'force-deletes the stale per-ticket branch');
  assert.match(fn, /stale-per-ticket-branch-deleting/, 'logs the deletion so operators can see it');
});

test('the stale-delete happens BEFORE the fresh push (order matters)', () => {
  const fn = extractFunction(dispatchSrc, 'createTaskPullRequest');
  const deleteIdx = fn.indexOf("push', 'origin', '--delete', branch");
  const pushIdx = fn.indexOf("push', '-u', 'origin', branch");
  assert.notEqual(deleteIdx, -1, 'delete call found');
  assert.notEqual(pushIdx, -1, 'fresh push call found');
  assert.ok(
    deleteIdx < pushIdx,
    `stale-delete (idx ${deleteIdx}) must precede fresh push (idx ${pushIdx}); if reversed, the push races the delete and the whole run dies again`,
  );
});

test('the stale-delete happens AFTER the existingPullRequest reuse check (safety invariant)', () => {
  const fn = extractFunction(dispatchSrc, 'createTaskPullRequest');
  const reuseIdx = fn.indexOf('existingPullRequest(branch)');
  const deleteIdx = fn.indexOf("push', 'origin', '--delete', branch");
  assert.ok(
    reuseIdx < deleteIdx,
    'reuse check must come first - otherwise we would force-delete a branch an open PR depends on',
  );
});

// Extract the body of a top-level `async function <name>(...) { ... }` from
// source. Balances braces so nested { } inside the function are included.
function extractFunction(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) return null;
  const openBrace = src.indexOf('{', start);
  if (openBrace === -1) return null;
  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}
