/**
 * worker.mjs — the LOCAL RUNTIME SWAP that makes day-shift different from
 * night-shift. Night-shift posts an `@codex` comment and lets Codex Cloud do
 * the work. Day-shift does the work itself, right here, by driving
 * `claude -p --dangerously-skip-permissions` over the user's Max subscription.
 *
 * Per ticket, runWorker():
 *   1. ensure today's HOLDING branch exists on origin (day-shift-staging-YYYY-MM-DD)
 *   2. create an EXTERNAL worktree branched dayshift/<issue>-<slug> off origin/Staging
 *   3. symlink node_modules + .env from the primary checkout (parallel-safe; no install)
 *   4. configure the day-shift git identity in the worktree
 *   5. write ticket-spec.md, then run `claude -p` with the worker system prompt,
 *      cwd = worktree, hard wall-clock timeout
 *   6. parse the output sentinel: COMPLETE | OUT-OF-SCOPE | STUCK | (none)
 *   7. on COMPLETE *with commits*: push the dayshift branch (guarded), open a
 *      DRAFT PR targeting the HOLDING branch, label the issue
 *   8. clean up the worktree
 *
 * Containment: the worker prompt forbids push/PRs and the safety perimeter; this
 * module routes the only push through git.mjs (dayshift/* + holding only, no
 * --force). The draft PR NEVER targets Staging or main — the user promotes by hand.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, symlink, rm, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  log,
  readConfig,
  slugifyTitle,
  todaysHoldingBranch,
  labelDateSuffix,
} from './lib.mjs';
import { createWorktree, removeWorktree, ensureHoldingBranch, gitPush } from './git.mjs';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = readConfig();

// Indirection over child_process.spawn so tests can inject a mock without
// having to reach into node internals. Production behaviour is unchanged;
// _spawn IS spawn unless _setSpawnForTests() has been called.
let _spawn = spawn;
/** Test-only: swap the spawn implementation runtime. Restore with `_setSpawnForTests(null)`. */
export function _setSpawnForTests(fn) {
  _spawn = fn || spawn;
}

// ─── helpers ───────────────────────────────────────────────────────────────

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

/** Symlink a shared heavy/secret file from primary into the worktree if present. */
async function linkShared(primaryRepo, worktreePath, name) {
  const src = path.join(primaryRepo, name);
  const dest = path.join(worktreePath, name);
  if ((await exists(src)) && !(await exists(dest))) {
    try {
      await symlink(src, dest);
      log.debug('worker', 'symlinked', { name });
    } catch (err) {
      log.warn('worker', 'symlink-failed', { name, error: err.message });
    }
  }
}

/**
 * Write the ticket brief into the SCRATCH dir (OUTSIDE the git worktree) so it
 * can never be committed into the PR. Returns nothing; the worker is given the
 * absolute scratch paths in its prompt.
 */
async function writeTicketSpec(scratchDir, issue) {
  const spec = `# Ticket #${issue.number}

**Title:** ${issue.title}

**URL:** ${issue.url}

**Labels:** ${(issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).join(', ') || '(none)'}

---

## Body

${issue.body || '(no body provided)'}

---

You are the day-shift worker. Follow your system prompt rules exactly: smallest
correct slice, never touch the safety perimeter, spend ZERO generation credits,
commit by exact path, do NOT push or open a PR. End with <promise>COMPLETE</promise>
when the acceptance criteria are genuinely met and green, or the appropriate
OUT-OF-SCOPE / STUCK sentinel otherwise.
`;
  await writeFile(path.join(scratchDir, 'ticket-spec.md'), spec, 'utf8');
  // Seed an empty progress log the worker appends to (also outside the repo).
  await writeFile(path.join(scratchDir, 'progress.txt'), '', 'utf8');
}

/** Configure the day-shift commit identity locally in the worktree. */
async function setWorktreeIdentity(worktreePath) {
  await execFileP('git', ['config', 'user.name', cfg.commitIdentity.name], { cwd: worktreePath });
  await execFileP('git', ['config', 'user.email', cfg.commitIdentity.email], { cwd: worktreePath });
}

/** Count the worker's own commits, i.e. those ahead of the worktree's base ref. */
async function commitsAhead(worktreePath, baseRef) {
  try {
    const { stdout } = await execFileP(
      'git', ['rev-list', '--count', `origin/${baseRef}..HEAD`],
      { cwd: worktreePath },
    );
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Build the argv prefix that wraps `claude` in `sandbox-exec` so the subprocess
 * can only touch its worktree + shared symlink targets + user config dirs.
 * Every (param "…") referenced in day-shift.sb MUST be bound via -D here or
 * sandbox-exec will refuse to start with "unbound variable".
 *
 * See tools/day-shift/day-shift.sb for the full threat-model + allowlist.
 */
function buildSandboxArgs(profilePath, params) {
  const args = [];
  for (const [k, v] of Object.entries(params)) {
    args.push('-D', `${k}=${v}`);
  }
  args.push('-f', profilePath);
  return args;
}

/**
 * Compute the -D bindings for day-shift.sb given a ticket's worktree + scratch
 * paths. All paths are absolute so the sandbox rules match exactly regardless
 * of the caller's cwd. HOME-relative paths for optional dotfiles (npmrc,
 * gitignore_global) are still passed even when the file doesn't exist —
 * sandbox-exec accepts non-existent literals; the rule just never matches.
 */
function sandboxParamsForTicket(worktreePath, scratchDir) {
  const home = process.env.HOME || '';
  return {
    WORKTREE: worktreePath,
    SCRATCH: scratchDir,
    WORKTREE_ROOT: cfg.worktreeRoot,
    PRIMARY_REPO: cfg.primaryRepo,
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
}

/**
 * Pure argv builder — separated from runClaude() so the compose behaviour
 * (sandbox flag AND factory-router pipeline overrides both landing in one
 * spawn call) is testable without actually spawning claude. Given the same
 * inputs, this ALWAYS returns the same `{ cmd, args }` shape.
 *
 * The `claudeBin` arg is passed explicitly (defaults to cfg.claudeBin) so
 * tests can pin it without touching the module-level config.
 */
export function buildClaudeSpawnArgs(systemPrompt, userPrompt, sandboxOpts, claudeBin = cfg.claudeBin) {
  const claudeArgs = [
    '-p', userPrompt,
    '--dangerously-skip-permissions',
    '--append-system-prompt', systemPrompt,
  ];
  if (sandboxOpts) {
    return {
      cmd: '/usr/bin/sandbox-exec',
      args: [
        ...buildSandboxArgs(sandboxOpts.profilePath, sandboxOpts.params),
        claudeBin,
        ...claudeArgs,
      ],
    };
  }
  return { cmd: claudeBin, args: claudeArgs };
}

/**
 * Run claude -p in the worktree with a hard wall-clock cap. Returns the full
 * stdout text. Streams nothing to the user (headless); logs key lines.
 *
 * When `sandboxOpts` is provided (opt-in via DAY_SHIFT_SANDBOX=1), the spawn
 * is wrapped in `sandbox-exec -f day-shift.sb -D …` so an escaped Claude Code
 * process cannot touch files outside its worktree + declared shared paths.
 * See day-shift.sb for the threat model. Default = no sandbox = current behavior.
 *
 * Exported so tests can inject a mocked spawn via `_setSpawnForTests()` and
 * verify the compose behaviour end-to-end without a real claude process.
 */
export function runClaude(worktreePath, systemPrompt, userPrompt, maxMinutes, sandboxOpts) {
  return new Promise((resolve) => {
    const { cmd, args: cmdArgs } = buildClaudeSpawnArgs(systemPrompt, userPrompt, sandboxOpts);

    log.info('worker', 'claude-start', {
      worktreePath,
      maxMinutes,
      sandbox: Boolean(sandboxOpts),
    });
    const child = _spawn(cmd, cmdArgs, {
      cwd: worktreePath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const killTimer = setTimeout(() => {
      log.warn('worker', 'claude-timeout-kill', { maxMinutes });
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    }, maxMinutes * 60 * 1000);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      log.info('worker', 'claude-exit', { code, outLen: out.length, errLen: err.length });
      resolve({ code, out, err });
    });
    child.on('error', (e) => {
      clearTimeout(killTimer);
      log.error('worker', 'claude-spawn-error', e.message);
      resolve({ code: -1, out, err: e.message });
    });
  });
}

function parseSentinel(text) {
  if (/<promise>\s*COMPLETE\s*<\/promise>/i.test(text)) return 'COMPLETE';
  if (/<promise>\s*OUT-OF-SCOPE\s*<\/promise>/i.test(text)) return 'OUT-OF-SCOPE';
  if (/<promise>\s*STUCK\s*<\/promise>/i.test(text)) return 'STUCK';
  return 'NONE';
}

/** Open a DRAFT PR from the dayshift branch → holding branch. Never Staging/main. */
/**
 * Extract the worker's TEST_ROUTE: {json} line from progress.txt (see
 * prompts/worker-system.md for the emission contract). Returns null when
 * the worker didn't emit one (change is not browser-testable) or when the
 * JSON is malformed. Field whitelist applied so an unexpected value in
 * progress.txt cannot inject arbitrary keys into the PR body.
 */
export function extractTestRoute(progressNotes) {
  const text = String(progressNotes || '');
  const m = text.match(/^\s*TEST_ROUTE:\s*(\{[\s\S]*?\})\s*$/m);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[1]); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.path !== 'string' || !parsed.path.startsWith('/')) {
    return null;
  }
  const out = { path: parsed.path.slice(0, 200) };
  if (Number.isFinite(parsed.port) && parsed.port > 0 && parsed.port < 65536) out.port = Number(parsed.port);
  if (typeof parsed.open === 'string' && parsed.open.trim()) out.open = parsed.open.trim().slice(0, 240);
  if (typeof parsed.hint === 'string' && parsed.hint.trim()) out.hint = parsed.hint.trim().slice(0, 240);
  return out;
}

async function openDraftPR(issue, branch, holdingBranch, sentinel, progressNotes, brainSnapshot) {
  const title = `[day-shift] #${issue.number}: ${issue.title}`.slice(0, 240);
  const notesBlock = progressNotes && progressNotes.trim()
    ? `\n<details><summary>🛠️ Worker progress notes (root cause / what it tried)</summary>\n\n\`\`\`\n${progressNotes.trim().slice(0, 6000)}\n\`\`\`\n</details>\n`
    : '';
  // Agent Brain snapshot as a hidden HTML comment. The shift-dashboard (CF
  // Worker) fetches PR bodies via the GitHub API and parses this block to
  // surface per-ticket attempt history + escalation + hint counts. Kept
  // compact (~200 bytes) so it's cheap to fetch + parse at the edge. Only
  // emitted when the dispatcher passed a snapshot; body shape unchanged
  // when the brain flag is off (empty string appends nothing meaningful).
  const brainBlock = brainSnapshot
    ? `\n\n<!-- agent-brain:v1 ${JSON.stringify(brainSnapshot)} -->\n`
    : '';
  // Test-route marker (from the worker's progress.txt if it declared the
  // change browser-testable). Rendered on the shift-dashboard as a "Test
  // in browser" link on the PR card. Empty string when the worker didn't
  // emit TEST_ROUTE - dashboard hides the affordance in that case.
  const testRoute = extractTestRoute(progressNotes);
  const testRouteBlock = testRoute
    ? `\n<!-- test-route:v1 ${JSON.stringify(testRoute)} -->\n`
    : '';
  const body = `Autonomous **day-shift** run (local Claude Code, Max subscription). The user did NOT initiate this - review before promoting.

Closes #${issue.number} once promoted.

- **Base (holding):** \`${holdingBranch}\` - deploys nowhere. Promote to Staging by hand after review.
- **Worker verdict:** ${sentinel}
- **Safety:** classifier marked this \`safe\` (no auth/payments/RLS/migrations/secrets/server.js/routes). Zero generation credits spent.

### Reviewer checklist before promoting to Staging
- [ ] Diff is scoped to the ticket only (no drift / unrelated refactor)
- [ ] \`npx tsc --noEmit\` green, touched tests green
- [ ] If UI: looks right + behaves right at desk
- [ ] No leftover debug code / temporary URLs / secrets
${notesBlock}
_Worker scratch files (ticket-spec / progress) live OUTSIDE the repo and are never committed - the notes above are the full record._${brainBlock}${testRouteBlock}`;

  const { stdout } = await execFileP('gh', [
    'pr', 'create',
    '--repo', cfg.repo,
    '--base', holdingBranch,
    '--head', branch,
    '--title', title,
    '--body', body,
    '--draft',
  ]);
  return stdout.trim();
}

async function ensureLabel(label, color, desc) {
  try {
    await execFileP('gh', ['label', 'create', label, '--repo', cfg.repo, '--color', color, '--description', desc]);
  } catch { /* exists */ }
}

async function labelIssue(issueNum, label) {
  try {
    await execFileP('gh', ['issue', 'edit', String(issueNum), '--repo', cfg.repo, '--add-label', label]);
  } catch (err) {
    log.warn('worker', 'label-failed', { issueNum, label, error: err.message });
  }
}

async function commentIssue(issueNum, body) {
  try {
    await execFileP('gh', ['issue', 'comment', String(issueNum), '--repo', cfg.repo, '--body', body]);
  } catch (err) {
    log.warn('worker', 'comment-failed', { issueNum, error: err.message });
  }
}

// ─── main entry ──────────────────────────────────────────────────────────────

/**
 * Load a pipeline definition module for the given work-type. Returns null
 * when the router is off (workType undefined) or the type is 'unknown' (map
 * to 'feature' — the widest safe default; keep the log line honest). Any
 * import failure (typo in name, missing file) is caught and treated as
 * "no pipeline" so a broken pipeline module can never wedge day-shift.
 */
export async function loadPipeline(workType) {
  if (!workType) return null;
  const type = workType === 'unknown' ? 'feature' : workType;
  try {
    const mod = await import(`./pipelines/${type}.mjs`);
    return mod.default || mod;
  } catch (err) {
    log.warn('worker', 'pipeline-load-failed', { workType, type, error: err.message });
    return null;
  }
}

/**
 * Run one ticket end-to-end locally.
 *
 * @param {object} issue  — GitHub issue payload
 * @param {object} [opts]
 * @param {string} [opts.workType] — Factory-Router verdict (hotfix|feature|bug|chore|unknown).
 *   When undefined (router flag off), the worker uses the baseline recipe
 *   unchanged — this is the pre-router behaviour and stays the default.
 *   Passing an options object (not a bare workType arg) so future extensions
 *   don't need to change the signature.
 * @returns {Promise<{ok:boolean, sentinel:string, prUrl?:string, reason?:string}>}
 */
export async function runWorker(issue, opts = {}) {
  const { workType, brainSummary, brainSnapshot } = opts;
  const slug = slugifyTitle(issue.title);
  const branch = `dayshift/${issue.number}-${slug}`;
  const worktreePath = path.join(cfg.worktreeRoot, `${issue.number}-${slug}`);
  const scratchDir = `${worktreePath}-scratch`; // OUTSIDE the git tree — never committable
  const primaryRepo = cfg.primaryRepo;
  const baseBranch = cfg.baseBranch;

  // Surface the sandbox opt-in in every run (including dry-run) so operators
  // can confirm the flag is picked up without needing a live claude spawn.
  const sandboxEnabled = process.env.DAY_SHIFT_SANDBOX === '1';
  // Same for the factory router — off by default; the pipeline is only
  // loaded when the flag is set AND a workType was passed by dispatch.
  const factoryRouterEnabled = process.env.DAY_SHIFT_FACTORY_ROUTER === '1';
  const pipelineDef = (factoryRouterEnabled && workType) ? await loadPipeline(workType) : null;
  log.info('worker', 'config', {
    issue: issue.number,
    sandbox: sandboxEnabled,
    factoryRouter: factoryRouterEnabled,
    workType: workType || null,
    pipeline: pipelineDef ? pipelineDef.workType : null,
  });

  if (cfg.mode === 'dry-run') {
    log.info('worker', 'DRY-RUN would-run', {
      issue: issue.number,
      branch,
      worktreePath,
      sandbox: sandboxEnabled,
      factoryRouter: factoryRouterEnabled,
      workType: workType || null,
      pipeline: pipelineDef ? pipelineDef.workType : null,
    });
    return { ok: true, sentinel: 'DRY-RUN', reason: 'dry-run' };
  }

  // 1. holding branch (ensureHoldingBranch fast-forwards it to current Staging
  //    when safe, so it stays a fresh base).
  const holdingBranch = await ensureHoldingBranch(primaryRepo, baseBranch);

  // 2. worktree branched from the HOLDING branch (NOT origin/Staging directly).
  //    This guarantees the per-ticket PR diff against holding shows ONLY the
  //    worker's changes — never the Staging delta as noise — even mid-day after
  //    other PRs have been folded into holding.
  await mkdir(cfg.worktreeRoot, { recursive: true });
  if (await exists(worktreePath)) {
    await removeWorktree(primaryRepo, worktreePath, { force: true }).catch(() => {});
  }
  await execFileP('git', ['fetch', 'origin', holdingBranch], { cwd: primaryRepo });
  await createWorktree(primaryRepo, worktreePath, branch, `origin/${holdingBranch}`);

  // scratch dir lives OUTSIDE the worktree so ticket-spec/progress can never be
  // committed into the PR (and thus never ride along to Staging on promote).
  await mkdir(scratchDir, { recursive: true });

  let result = { ok: false, sentinel: 'NONE' };
  try {
    // 3. shared symlinks (no npm install — per parallel-worktree rule)
    await linkShared(primaryRepo, worktreePath, 'node_modules');
    await linkShared(primaryRepo, worktreePath, '.env');
    await linkShared(primaryRepo, worktreePath, '.env.local');

    // 4. identity + 5. ticket spec (into scratch dir, outside the repo)
    await setWorktreeIdentity(worktreePath);
    await writeTicketSpec(scratchDir, issue);

    // 5. run the worker — scratch paths are absolute so the worker reads/writes
    //    them without ever touching the git tree.
    const baseSystemPrompt = await readFile(path.join(__dirname, 'prompts', 'worker-system.md'), 'utf8');
    // Factory-router pipeline overrides. The augment is appended BEFORE the
    // ticket-spec is referenced (ticket-spec is loaded via the user prompt),
    // so from the worker's POV the appended rules read like an extension of
    // the base system prompt — same shape as the sandbox flag: additive, off
    // by default, no behaviour change when pipelineDef is null.
    let systemPrompt = pipelineDef && pipelineDef.systemPromptAugment
      ? `${baseSystemPrompt}\n\n${pipelineDef.systemPromptAugment}`
      : baseSystemPrompt;
    // Agent Brain: prepend prior-attempts summary + hints when the dispatcher
    // built one (DAY_SHIFT_AGENT_BRAIN=1 + non-empty for this ticket). Put it
    // at the TOP so the worker reads it before the general instructions - the
    // "you have tried this N times, do not restart" signal has to arrive early
    // or an autoregressive model has already committed to a plan.
    if (brainSummary && brainSummary.length) {
      systemPrompt = `${brainSummary}\n\n${systemPrompt}`;
      log.info('worker', 'brain-summary-prepended', {
        issue: issue.number,
        bytes: brainSummary.length,
      });
    }
    const effectiveMaxMinutes = (pipelineDef && typeof pipelineDef.maxIterMinutes === 'number' && pipelineDef.maxIterMinutes > 0)
      ? pipelineDef.maxIterMinutes
      : cfg.maxIterMinutes;
    if (pipelineDef) {
      log.info('worker', 'pipeline-applied', {
        workType: pipelineDef.workType,
        maxIterMinutes: effectiveMaxMinutes,
        promptAugmented: Boolean(pipelineDef.systemPromptAugment),
        notes: pipelineDef.notes || null,
      });
    }
    const ticketPath = path.join(scratchDir, 'ticket-spec.md');
    const progressPath = path.join(scratchDir, 'progress.txt');
    const userPrompt =
      `Complete the ticket described in ${ticketPath}. Work ONLY inside this worktree (your cwd). ` +
      `Use ${progressPath} as your scratch progress log (it is OUTSIDE the repo — append to it, but NEVER git add it). ` +
      'Follow every rule in your appended system prompt. Do not push or open a PR. ' +
      'End with the appropriate <promise>...</promise> sentinel.';
    // Opt-in macOS sandbox (DAY_SHIFT_SANDBOX=1). Off by default so existing
    // installs don't change behavior on upgrade. See day-shift.sb for the
    // full threat model + allowlist.
    const sandboxOpts = process.env.DAY_SHIFT_SANDBOX === '1'
      ? {
          profilePath: path.join(__dirname, 'day-shift.sb'),
          params: sandboxParamsForTicket(worktreePath, scratchDir),
        }
      : null;
    const { out } = await runClaude(worktreePath, systemPrompt, userPrompt, effectiveMaxMinutes, sandboxOpts);
    const sentinel = parseSentinel(out);
    result.sentinel = sentinel;
    const progressNotes = await readFile(progressPath, 'utf8').catch(() => '');

    const ahead = await commitsAhead(worktreePath, holdingBranch);
    log.info('worker', 'post-run', { issue: issue.number, sentinel, commitsAhead: ahead });

    if (sentinel === 'COMPLETE' && ahead > 0) {
      // 7. push + draft PR + label
      await gitPush(worktreePath, branch);
      const prUrl = await openDraftPR(issue, branch, holdingBranch, sentinel, progressNotes, brainSnapshot);
      const label = `day-shift:review-${labelDateSuffix()}`;
      await ensureLabel(label, '5319E7', `Day-shift draft PR awaiting desk review on ${holdingBranch}`);
      await labelIssue(issue.number, label);
      await commentIssue(
        issue.number,
        `🌞 **Day-shift** completed a draft for this ticket (local Claude Code, autonomous).\n\nDraft PR → \`${holdingBranch}\` (holding): ${prUrl}\n\nReview at your desk; promote the holding branch to Staging when satisfied. No generation credits were spent.`,
      );
      result = { ok: true, sentinel, prUrl };
    } else if (sentinel === 'OUT-OF-SCOPE') {
      // Label so it's skipped next run (it'll just OUT-OF-SCOPE again otherwise).
      const label = 'day-shift:needs-human';
      await ensureLabel(label, 'B60205', 'Day-shift attempted but could not complete autonomously; needs a human');
      await labelIssue(issue.number, label);
      await commentIssue(
        issue.number,
        `🌞 Day-shift looked at this and backed out: **out of scope** for autonomous work (safety perimeter or needs generation/credits). Labeled \`day-shift:needs-human\` so it isn't re-attempted automatically. Leaving for a human. No changes pushed.`,
      );
      result = { ok: true, sentinel, reason: 'out-of-scope' };
    } else {
      // STUCK or NONE or COMPLETE-without-commits — push nothing, and label the
      // issue so the dispatcher's ALREADY_CLAIMED filter skips it next time.
      // Without this, an unfinishable ticket (e.g. one needing a perimeter file)
      // gets re-attempted every run, burning ~25 min of Max tokens each fire.
      log.warn('worker', 'no-pr', { issue: issue.number, sentinel, ahead });
      const label = 'day-shift:needs-human';
      await ensureLabel(label, 'B60205', 'Day-shift attempted but could not complete autonomously; needs a human');
      await labelIssue(issue.number, label);
      await commentIssue(
        issue.number,
        `🌞 Day-shift attempted this autonomously but could not complete it (verdict: ${sentinel}${ahead === 0 ? ', no commits' : ''}). Labeled \`day-shift:needs-human\` so it isn't re-attempted automatically — leaving for a human.`,
      );
      result = { ok: false, sentinel, reason: ahead === 0 ? 'no-commits' : 'no-complete-sentinel' };
    }
  } finally {
    // 8. always clean up the worktree + scratch dir (commits live on the pushed branch)
    await removeWorktree(primaryRepo, worktreePath, { force: true }).catch((e) =>
      log.warn('worker', 'cleanup-failed', { worktreePath, error: e.message }),
    );
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }

  return result;
}
