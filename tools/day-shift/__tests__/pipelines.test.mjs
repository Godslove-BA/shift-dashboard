// Shape + compose tests for tools/day-shift/pipelines/*.mjs — the four
// per-work-type pipeline definitions that the Factory Router dispatches to
// (ADW pattern).
//
// WHY these tests:
//   1. Every pipeline MUST export the same field set — otherwise a
//      typo'd export (e.g. `maxMinutes` instead of `maxIterMinutes`)
//      silently falls back to the baseline recipe and the tighter clock
//      never applies. That's the kind of bug you don't notice until a
//      hotfix quietly runs for 25 minutes on the Max quota.
//   2. Track-specific invariants (hotfix < baseline clock, chore < hotfix,
//      each augment references its own track by name) are asserted here
//      so a well-meaning edit to one pipeline's augment can't drift out
//      of sync with the others.
//   3. The compose test verifies that DAY_SHIFT_SANDBOX + the factory
//      router play nicely together — the sandbox opts and the pipeline's
//      augmented system prompt both land in the SAME `buildClaudeSpawnArgs`
//      output, so we can prove the two features are additive (per the
//      task brief) without spawning a real claude.
//
// Run: node --test tools/day-shift/__tests__/pipelines.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPipeline, buildClaudeSpawnArgs } from '../worker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = path.resolve(__dirname, '..', 'pipelines');

const ALL_TYPES = ['hotfix', 'feature', 'bug', 'chore'];
const REQUIRED_FIELDS = [
  'workType',
  'maxIterMinutes',
  'allowScopeCreep',
  'allowNewDeps',
  'systemPromptAugment',
  'verificationCommands',
  'notes',
];

// ─── shape tests ───────────────────────────────────────────────────────────

for (const type of ALL_TYPES) {
  test(`pipeline ${type}: default export has every required field`, async () => {
    const mod = await import(path.join(PIPELINE_DIR, `${type}.mjs`));
    const def = mod.default;
    assert.ok(def, `${type}.mjs must have a default export`);
    for (const f of REQUIRED_FIELDS) {
      assert.ok(f in def, `${type}.mjs is missing field '${f}'`);
    }
  });

  test(`pipeline ${type}: workType field matches the file name`, async () => {
    const mod = await import(path.join(PIPELINE_DIR, `${type}.mjs`));
    assert.equal(mod.default.workType, type);
    // Named export must agree with default too — catches copy-paste mistakes.
    assert.equal(mod.workType, type);
  });

  test(`pipeline ${type}: systemPromptAugment is always a string (may be empty)`, async () => {
    const mod = await import(path.join(PIPELINE_DIR, `${type}.mjs`));
    assert.equal(typeof mod.default.systemPromptAugment, 'string');
  });

  test(`pipeline ${type}: verificationCommands is a non-empty array of strings`, async () => {
    const mod = await import(path.join(PIPELINE_DIR, `${type}.mjs`));
    const cmds = mod.default.verificationCommands;
    assert.ok(Array.isArray(cmds), `${type}.verificationCommands must be an array`);
    assert.ok(cmds.length >= 1, `${type}.verificationCommands must have at least one entry`);
    for (const c of cmds) assert.equal(typeof c, 'string');
  });

  test(`pipeline ${type}: notes is a short human-readable string`, async () => {
    const mod = await import(path.join(PIPELINE_DIR, `${type}.mjs`));
    assert.equal(typeof mod.default.notes, 'string');
    assert.ok(mod.default.notes.length > 0);
    assert.ok(mod.default.notes.length <= 200, `${type}.notes should stay under ~200 chars for log lines`);
  });

  test(`pipeline ${type}: maxIterMinutes is null OR a positive number`, async () => {
    const mod = await import(path.join(PIPELINE_DIR, `${type}.mjs`));
    const m = mod.default.maxIterMinutes;
    assert.ok(m === null || (typeof m === 'number' && m > 0), `${type}.maxIterMinutes is invalid: ${m}`);
  });
}

// ─── per-track invariant tests ─────────────────────────────────────────────

test('hotfix pipeline: wall clock is TIGHTER than baseline (25 min)', async () => {
  const mod = await import(path.join(PIPELINE_DIR, 'hotfix.mjs'));
  assert.ok(mod.default.maxIterMinutes < 25, `hotfix maxIterMinutes ${mod.default.maxIterMinutes} must be < 25`);
});

test('chore pipeline: wall clock is TIGHTER than hotfix (chore should be smallest)', async () => {
  const hotfix = (await import(path.join(PIPELINE_DIR, 'hotfix.mjs'))).default;
  const chore = (await import(path.join(PIPELINE_DIR, 'chore.mjs'))).default;
  assert.ok(chore.maxIterMinutes < hotfix.maxIterMinutes, `chore ${chore.maxIterMinutes} must be < hotfix ${hotfix.maxIterMinutes}`);
});

test('feature pipeline: maxIterMinutes is null (baseline) — no override', async () => {
  // Explicit `null` is important: it signals "use cfg.maxIterMinutes" to the
  // worker. If someone forgot to set the field, `undefined` would slip
  // through — the shape test above catches that, and this test pins the
  // intent that features share the default clock.
  const mod = await import(path.join(PIPELINE_DIR, 'feature.mjs'));
  assert.equal(mod.default.maxIterMinutes, null);
});

test('bug pipeline: maxIterMinutes is null (baseline) but augment REQUIRES a regression test', async () => {
  const mod = await import(path.join(PIPELINE_DIR, 'bug.mjs'));
  assert.equal(mod.default.maxIterMinutes, null);
  // The augment must mention the regression-test rule in some form — this is
  // the bug pipeline's #1 differentiator vs feature.
  assert.match(mod.default.systemPromptAugment, /regression test/i);
});

test('hotfix pipeline: augment mentions single-file + shorter clock rules', async () => {
  const mod = await import(path.join(PIPELINE_DIR, 'hotfix.mjs'));
  assert.match(mod.default.systemPromptAugment, /single-file|one file/i);
  assert.match(mod.default.systemPromptAugment, /15 minute|15-minute|15 min/i);
});

test('chore pipeline: augment forbids touching runtime logic', async () => {
  const mod = await import(path.join(PIPELINE_DIR, 'chore.mjs'));
  assert.match(mod.default.systemPromptAugment, /runtime logic|runtime code/i);
});

test('feature pipeline: augment is an empty string (baseline unchanged)', async () => {
  const mod = await import(path.join(PIPELINE_DIR, 'feature.mjs'));
  assert.equal(mod.default.systemPromptAugment, '');
});

test('every pipeline: scope-creep + new-deps are BOTH disallowed', async () => {
  // Uniform posture across tracks — day-shift is autonomous, so scope drift
  // and stealth dep bumps are the two failure modes we can't afford anywhere.
  for (const type of ALL_TYPES) {
    const mod = await import(path.join(PIPELINE_DIR, `${type}.mjs`));
    assert.equal(mod.default.allowScopeCreep, false, `${type}.allowScopeCreep must be false`);
    assert.equal(mod.default.allowNewDeps, false, `${type}.allowNewDeps must be false`);
  }
});

// ─── loadPipeline() behaviour ──────────────────────────────────────────────

test('loadPipeline(undefined) → null (router flag off)', async () => {
  assert.equal(await loadPipeline(undefined), null);
});

test('loadPipeline("unknown") → maps to feature (safe wide default)', async () => {
  const p = await loadPipeline('unknown');
  assert.ok(p);
  assert.equal(p.workType, 'feature');
});

test('loadPipeline("hotfix") → returns the hotfix module', async () => {
  const p = await loadPipeline('hotfix');
  assert.equal(p.workType, 'hotfix');
  assert.equal(p.maxIterMinutes, 15);
});

test('loadPipeline(typo) → null, does not throw', async () => {
  // A broken workType (typo in the router or a stale label) must not wedge
  // the worker — falling back to null means the baseline recipe runs.
  const p = await loadPipeline('not-a-real-pipeline');
  assert.equal(p, null);
});

// ─── compose test: sandbox (PR #1256) + factory router play nicely ─────────

test('compose: buildClaudeSpawnArgs wraps sandbox AND carries the hotfix-augmented prompt', async () => {
  // The task-brief compose requirement: DAY_SHIFT_SANDBOX=1 AND
  // DAY_SHIFT_FACTORY_ROUTER=1 must both apply in a single spawn without
  // clobbering each other. We reproduce the exact composition worker.mjs
  // does — load pipeline → augment prompt → build spawn args with sandbox
  // opts — and assert both features are visible in the output.
  const pipeline = await loadPipeline('hotfix');
  assert.ok(pipeline);

  const basePrompt = '# Base worker system prompt\nRule 1: do the smallest correct thing.';
  const composedPrompt = `${basePrompt}\n\n${pipeline.systemPromptAugment}`;
  const userPrompt = 'Complete the ticket at /tmp/ticket-spec.md';

  // Realistic sandbox shape — matches what worker.mjs builds via
  // sandboxParamsForTicket(). We only need enough params for the argv
  // builder to interpolate them; we're not actually spawning.
  const sandboxOpts = {
    profilePath: '/abs/tools/day-shift/day-shift.sb',
    params: {
      WORKTREE: '/tmp/wt',
      SCRATCH: '/tmp/wt-scratch',
      WORKTREE_ROOT: '/tmp',
      PRIMARY_REPO: '/repo',
      HOME_DIR: '/home/u',
      CLAUDE_HOME: '/home/u/.claude',
      NPM_CACHE: '/home/u/.npm',
      USER_CACHE: '/home/u/.cache',
      GH_CONFIG: '/home/u/.config',
      GH_STATE: '/home/u/.local',
      HOME_SSH: '/home/u/.ssh',
      HOME_GITCONFIG: '/home/u/.gitconfig',
      HOME_GITIGNORE: '/home/u/.gitignore_global',
      HOME_NPMRC: '/home/u/.npmrc',
    },
  };

  const { cmd, args } = buildClaudeSpawnArgs(composedPrompt, userPrompt, sandboxOpts, '/usr/local/bin/claude');

  // 1. Sandbox wrap is intact — cmd is sandbox-exec, not claude directly.
  assert.equal(cmd, '/usr/bin/sandbox-exec');
  // 2. Sandbox profile path is in the argv (it goes right before -D bindings).
  assert.ok(args.includes('-f'));
  assert.ok(args.includes(sandboxOpts.profilePath));
  // 3. At least one -D binding for a known param is present.
  const dArgs = args.filter((a) => a.startsWith('WORKTREE=') || a.startsWith('SCRATCH='));
  assert.ok(dArgs.length >= 2, 'expected WORKTREE + SCRATCH bindings after -D');
  // 4. The claude bin is invoked INSIDE the sandbox wrap.
  assert.ok(args.includes('/usr/local/bin/claude'));
  // 5. Pipeline augment made it into --append-system-prompt.
  const appendIdx = args.indexOf('--append-system-prompt');
  assert.ok(appendIdx > 0, 'missing --append-system-prompt');
  const passedPrompt = args[appendIdx + 1];
  assert.match(passedPrompt, /HOTFIX PIPELINE/, 'hotfix augment not present in appended prompt');
  assert.match(passedPrompt, /Base worker system prompt/, 'base prompt not present in appended prompt');
  // 6. User prompt is passed via -p (unchanged by either feature).
  const pIdx = args.indexOf('-p');
  assert.ok(pIdx >= 0);
  assert.equal(args[pIdx + 1], userPrompt);
});

test('compose: factory router alone (no sandbox) still carries the augment', async () => {
  const pipeline = await loadPipeline('chore');
  const composedPrompt = `# base\n\n${pipeline.systemPromptAugment}`;
  const { cmd, args } = buildClaudeSpawnArgs(composedPrompt, 'user', null, '/bin/claude');
  assert.equal(cmd, '/bin/claude', 'no sandbox → cmd is the claude bin directly');
  const appendIdx = args.indexOf('--append-system-prompt');
  assert.match(args[appendIdx + 1], /CHORE PIPELINE/);
});

test('compose: sandbox alone (no router) is unchanged — baseline prompt only', async () => {
  // Pre-router behaviour: worker.mjs would pass the base prompt untouched
  // when DAY_SHIFT_FACTORY_ROUTER is off. buildClaudeSpawnArgs must accept
  // that exact input without adding anything.
  const sandboxOpts = {
    profilePath: '/abs/day-shift.sb',
    params: { WORKTREE: '/tmp/wt' },
  };
  const { cmd, args } = buildClaudeSpawnArgs('base prompt only', 'user', sandboxOpts, '/bin/claude');
  assert.equal(cmd, '/usr/bin/sandbox-exec');
  const appendIdx = args.indexOf('--append-system-prompt');
  assert.equal(args[appendIdx + 1], 'base prompt only', 'baseline prompt must not be mutated when router off');
});

test('compose: no sandbox and no router is the pre-existing baseline', async () => {
  const { cmd, args } = buildClaudeSpawnArgs('base', 'user', null, '/bin/claude');
  assert.equal(cmd, '/bin/claude');
  assert.deepEqual(args, ['-p', 'user', '--dangerously-skip-permissions', '--append-system-prompt', 'base']);
});
