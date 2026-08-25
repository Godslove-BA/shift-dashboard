// Behavior tests for runInParallel (day-shift's concurrency pool).
//
// The pool is what turns "one ticket per dispatch run" into "N tickets in
// parallel". It's tiny, but correctness matters: wrong order = wrong Telegram
// digest / wrong Playwright evidence attribution, and wrong concurrency clamp =
// silent serial fallback that looks like it's working.
//
// Run with: node --test tools/day-shift/__tests__/runInParallel.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { runInParallel } from '../lib.mjs';

test('results are in ORIGINAL positional order, not completion order', async () => {
  // fn resolves slower for smaller indices so completion order would flip if
  // the pool naively pushed on settle. We assert we still get original order.
  const items = [0, 1, 2, 3, 4];
  const out = await runInParallel(items, 3, async (n) => {
    await sleep(30 - n * 5); // 30, 25, 20, 15, 10ms
    return n * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40]);
});

test('never exceeds the concurrency cap', async () => {
  let inflight = 0;
  let peak = 0;
  const N = 12;
  const items = Array.from({ length: N }, (_, i) => i);
  await runInParallel(items, 3, async () => {
    inflight++;
    if (inflight > peak) peak = inflight;
    await sleep(20);
    inflight--;
  });
  assert.equal(peak, 3, `peak concurrency was ${peak}, expected 3`);
});

test('cap is clamped to items.length (no idle worker slots)', async () => {
  let starts = 0;
  await runInParallel([1, 2], 10, async () => {
    starts++;
    await sleep(5);
  });
  // If unclamped, the pool would spin up 10 workers - most sit idle immediately
  // and return. We can only measure starts of fn(), which equals items.length
  // either way, but the clamp matters for the perf argument in the config.
  assert.equal(starts, 2);
});

test('concurrency=1 = serial (backward-compat with legacy default)', async () => {
  let inflight = 0;
  let peak = 0;
  await runInParallel([1, 2, 3, 4, 5], 1, async () => {
    inflight++;
    if (inflight > peak) peak = inflight;
    await sleep(5);
    inflight--;
  });
  assert.equal(peak, 1);
});

test('concurrency=0 is treated as 1 (no divide-by-zero / stall)', async () => {
  const out = await runInParallel([1, 2, 3], 0, async (n) => n * 2);
  assert.deepEqual(out, [2, 4, 6]);
});

test('an fn that throws rejects the whole pool (dispatch wraps for continue-on-throw)', async () => {
  await assert.rejects(
    () => runInParallel([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/,
  );
});

test('empty items → empty results, no work', async () => {
  let calls = 0;
  const out = await runInParallel([], 5, async () => { calls++; });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});
