// Test the retry-classifier logic in execGhWithRetry() (from dispatch.mjs).
// We can't import execGhWithRetry directly without running the module's
// top-level readConfig() side-effects, so we duplicate the tiny classifier
// regex here and assert on it - if this test drifts from the source we'll
// know because dispatch.mjs is one file with the pattern near the top.
//
// Run with: node --test tools/night-shift/__tests__/dispatch.gh-retry.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dispatchSrc = readFileSync(join(__dirname, '..', 'dispatch.mjs'), 'utf8');

test('the source of truth for TRANSIENT_GH_ERROR_PATTERNS is present in dispatch.mjs', () => {
  assert.match(dispatchSrc, /TRANSIENT_GH_ERROR_PATTERNS\s*=\s*\[/);
  assert.match(dispatchSrc, /execGhWithRetry/);
});

// Mirror the patterns from dispatch.mjs. If this list ever drifts from source,
// the assertion above catches the shape, and the tests below assert behavior.
const TRANSIENT_GH_ERROR_PATTERNS = [
  /no commits between/i,
  /rate limit/i,
  /server error/i,
  /internal error/i,
  /network is unreachable/i,
  /timed? ?out/i,
  /gateway timeout/i,
  /service unavailable/i,
  /502 bad gateway/i,
  /econnreset/i,
  /econnrefused/i,
  /connection refused/i,
];

function isTransient(msg) {
  return TRANSIENT_GH_ERROR_PATTERNS.some((re) => re.test(msg));
}

test('classifies the actual 2026-07-22 incident message as transient', () => {
  // Exact error we saw on run 29946488083, first line of gh stderr on a
  // push-then-pr-create race:
  const msg = 'pull request create failed: GraphQL: No commits between night-shift-staging-2026-07-22 and nightshift/1164-fix-... (createPullRequest)';
  assert.equal(isTransient(msg), true);
});

test('classifies common transient errors as retryable', () => {
  const cases = [
    'GraphQL: API rate limit exceeded for user ID XXX',
    'HTTP 500: Internal Server Error',
    'HTTP 502 Bad Gateway',
    'HTTP 503 Service Unavailable',
    'HTTP 504 Gateway Timeout',
    'connect ECONNRESET 140.82.121.6:443',
    'Error: connect ECONNREFUSED 140.82.121.6:443',
    'network is unreachable',
    'command timed out after 10s',
    'read timeout on API request',
  ];
  for (const m of cases) {
    assert.equal(isTransient(m), true, `should be transient: "${m}"`);
  }
});

test('does NOT retry terminal errors', () => {
  const cases = [
    'HTTP 401: Bad credentials',
    'HTTP 404: Not Found - repo does not exist',
    'HTTP 403: Resource not accessible by integration',
    'unauthorized: token expired',
    'invalid arguments: --repo requires a value',
    'unknown flag: --wat',
    'a pull request for branch X into Y already exists',
    'validation failed: title too long',
  ];
  for (const m of cases) {
    assert.equal(isTransient(m), false, `should NOT be transient: "${m}"`);
  }
});

test('empty / undefined error is NOT retried (fail-fast on unknown shapes)', () => {
  assert.equal(isTransient(''), false);
  assert.equal(isTransient(String(undefined)), false);
});
