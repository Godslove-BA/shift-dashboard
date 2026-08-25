# Day Shift — autonomous daytime ticket pickup on your Max subscription

The **daytime twin of night-shift**. While night-shift drains the queue overnight via Codex Cloud, day-shift picks up tickets **during your day, on your own awake Mac, driven by `claude -p`** (the Claude subscription — $0 marginal cost, burning the monthly token allowance you normally leave unused).

You and the other dev are the bottleneck because ticket pickup is manual. Day-shift removes that: it claims a safe ticket, does the work in an isolated worktree, and parks a **draft PR in a holding branch you promote when you glance over** — so nothing you didn't initiate can reach Staging.

## How it differs from night-shift

| | night-shift v2 | **day-shift** |
|---|---|---|
| Runtime | GitHub Actions + Codex Cloud | **local `claude -p` on your Mac** |
| Cost | metered Codex Cloud | **$0 marginal (Max sub)** |
| When | overnight cron (23:00 UTC) | **every 30 min while Mac awake** |
| Lands in | `night-shift-staging-*` | **`day-shift-staging-*` (holding)** |
| Branches / labels | `nightshift/*`, `night-shift:*` | `dayshift/*`, `day-shift:*` |
| Promotion | morning-review skill | you, at your desk |

It **reuses night-shift's safety brain verbatim** — `classifyIssue()` (danger-list) and `verifyFirst()` (dedup preflight) are imported from `../night-shift/`, not copied.

## Safety model (why it's OK that you didn't start the session)

1. **Auto-pick, skip the danger list.** Only tickets `classifyIssue()` rates `safe` are attempted — auth, payments, RLS, migrations, secrets, `server.js`, routes, security-class, vague, and in-progress tickets are all auto-rejected. Already-claimed tickets (`day-shift:*`, `night-shift:*`, `In progress`, `ready-for-testing`) are skipped.
2. **Zero generation credits.** The worker prompt forbids firing any image/video/music generation. Build-and-wire code only; QA read-only. The 300-credit ceiling is never approached.
3. **Holding branch only.** Draft PRs target `day-shift-staging-YYYY-MM-DD`, which deploys nowhere. The guarded `git.mjs` physically refuses to push anything except `dayshift/*` and the holding branch — no path to Staging/main, no `--force`.
4. **Worktree-isolated.** Each ticket runs in `~/day-shift-worktrees/<issue>-<slug>` with `node_modules`/`.env` symlinked (no install), so a parallel human/Codex session can't be clobbered.
5. **Single-instance lock + 25-min wall-clock cap** per ticket.

## Try it safely first (dry-run — touches nothing)

```bash
cd <this repo>
MODE=dry-run node tools/day-shift/dispatch.mjs
```

Prints the tickets it *would* pick up. Spawns no `claude`, creates no branch, opens no PR.

## Run one ticket live, by hand (no LaunchAgent yet)

```bash
MODE=auto MAX_TICKETS=1 node tools/day-shift/dispatch.mjs
```

Watch `~/day-shift-worktrees/day-shift.err.log` for structured logs. On `COMPLETE` you'll get a draft PR on the holding branch + a `day-shift:review-<date>` label on the issue.

## Install the LaunchAgent (every-30-min while awake)

```bash
sed -e "s#__REPO__#$(pwd)#g" -e "s#__HOME__#$HOME#g" \
  tools/day-shift/com.example.day-shift.plist.template \
  > ~/Library/LaunchAgents/com.example.day-shift.plist
launchctl load -w ~/Library/LaunchAgents/com.example.day-shift.plist
```

Recommend setting `MODE=dry-run` in the plist for the first day, watch the logs, then flip to `auto`.

Stop it: `launchctl unload -w ~/Library/LaunchAgents/com.example.day-shift.plist`

## Promote work to Staging (your gate)

When a draft PR looks good:

```bash
git fetch origin
git checkout Staging && git pull
git merge --no-ff origin/day-shift-staging-YYYY-MM-DD
git push origin Staging          # Staging CI runs; soak per CLAUDE.md before main
```

Or just merge the holding branch → Staging in the GitHub UI. Production (`main`) still requires your explicit approval, exactly as today.

## Config (env vars)

| var | default | meaning |
|---|---|---|
| `MODE` | `auto` | `auto` \| `dry-run` |
| `MAX_TICKETS` | `1` | tickets picked per run |
| `CONCURRENCY` | `1` | parallel workers per run (clamped `[1, 6]`; `3` is tested sweet spot on 16GB M-series - above 4 burns Max quota N× faster with diminishing return) |
| `DAY_SHIFT_PRIMARY_REPO` | `cwd` | your primary checkout path |
| `DAY_SHIFT_REPO` | `your-org/your-repo` | GitHub repo |
| `DAY_SHIFT_BASE_BRANCH` | `Staging` | branch worktrees fork from |
| `DAY_SHIFT_MAX_MINUTES` | `25` | per-ticket wall-clock cap |
| `DAY_SHIFT_SANDBOX` | *(off)* | set to `1` to wrap `claude -p` in `sandbox-exec` (macOS-only, see below) |
| `DAY_SHIFT_FACTORY_ROUTER` | *(off)* | set to `1` to classify tickets by work-type and route to per-type pipelines (see below) |
| `CLAUDE_BIN` | `claude` | path to the Claude Code CLI |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | optional run summaries |

## Factory Router + specialized pipelines (opt-in)

`DAY_SHIFT_FACTORY_ROUTER=1` enables the ADW-style [Factory Router](https://en.wikipedia.org/wiki/Design_pattern) pattern: instead of running every safe ticket through one worker recipe, day-shift first classifies each ticket by work-type (`hotfix` / `feature` / `bug` / `chore` / `unknown`) and routes it to a per-type **pipeline definition** in `tools/day-shift/pipelines/` that appends track-specific rules to the worker system prompt and can shorten the wall-clock cap.

**Why:** hotfixes need a tighter recipe (small scope, short clock, prefer feature-flag rollback); bugs need a mandatory regression test in the same PR; chores don't need the full 25-minute clock or e2e verification. One recipe for all four is the "one big agent" trap — the more shapes of work go through one funnel, the worse the funnel fits each one.

**Classifier rules** (see `factory-router.mjs`, precedence: title > label > default):

| Trigger | → workType |
|---|---|
| Title starts `hotfix:` / `fix(hotfix):` OR label `hotfix` / `urgent` / `p0` | `hotfix` |
| Title starts `feat:` / `feature:` OR label `enhancement` / `feature` | `feature` |
| Title starts `fix:` / `bug:` OR label `bug` / `defect` / `regression` | `bug` |
| Title starts `chore:` / `docs:` / `test:` / `refactor:` OR label `chore` / `documentation` / `test` | `chore` |
| Anything else | `unknown` (routes to `feature` recipe — widest safe default) |

**Pipeline overrides:**

| workType | maxIterMinutes | scope-creep | new-deps | key rule added to the worker prompt |
|---|---|---|---|---|
| `hotfix` | 15 | ✗ | ✗ | At most one file changed; regression test if testable; prefer env-var/feature-flag gating for easy rollback. |
| `feature` | 25 (baseline) | ✗ | ✗ | Baseline rules unchanged. Also handles `unknown`. |
| `bug` | 25 (baseline) | ✗ | ✗ | Reproduce with a failing test FIRST; regression test lives in the SAME PR as the fix. |
| `chore` | 10 | ✗ | ✗ | Runtime code under `src/` is off-limits; docs/tests/config only; lint+typecheck verification. |

**Enable it:**
```bash
export DAY_SHIFT_FACTORY_ROUTER=1
MODE=dry-run node tools/day-shift/dispatch.mjs   # confirm flag picked up (grep 'factory-route' in stderr)
MODE=auto MAX_TICKETS=1 node tools/day-shift/dispatch.mjs   # one live ticket
```

For the LaunchAgent, add `<key>DAY_SHIFT_FACTORY_ROUTER</key><string>1</string>` under `EnvironmentVariables` in your plist and `launchctl unload && launchctl load` it.

**Composes with `DAY_SHIFT_SANDBOX=1`.** The two flags are independent — you can enable either, both, or neither. When both are set, each ticket runs sandboxed AND under its per-type pipeline. See the compose test in `__tests__/pipelines.test.mjs`.

**Rollback:** unset (or omit) `DAY_SHIFT_FACTORY_ROUTER`. The classifier stops running; every ticket goes through the baseline recipe exactly as today.

**Smoke test:** `node --test tools/day-shift/__tests__/factory-router.test.mjs` (classifier verdicts) + `node --test tools/day-shift/__tests__/pipelines.test.mjs` (per-pipeline shape + compose).

## macOS filesystem sandbox (opt-in)

`DAY_SHIFT_SANDBOX=1` wraps each `claude -p` spawn in `/usr/bin/sandbox-exec` using the profile `tools/day-shift/day-shift.sb`. Off by default so existing installs don't change behaviour on upgrade.

**What it defends against:** an escaped Claude Code subprocess (or a tool it invokes) reaching files OUTSIDE its ticket worktree — the rest of `~/Desktop`, other repos, `~/Library/Application Support/*`, keychains, notes, etc. `deny default` + narrow allowlist means anything we forgot to list is denied, not silently granted.

**What it does NOT defend against:**
- Malicious npm packages — `node_modules` is symlinked in from the primary repo (per the parallel-worktree rule), so the subprocess reads them as if local. This is a supply-chain concern, not a sandbox concern.
- Network exfiltration — outbound network is fully allowed (Claude needs `api.anthropic.com`; git needs `github.com`; DNS needs mDNSResponder). Sandbox is filesystem-shaped.
- The worker script itself — `worker.mjs` runs unsandboxed; only the spawned `claude -p` subprocess is confined.
- Anything the profile grants explicitly — the R/W allowlist covers the worktree, the symlinked primary repo, `~/.claude`, `~/.npm`, `~/.cache`, `~/.config`, `~/.local`, plus system temp (`/tmp`, `/var/folders`).

**Enable it:**
```bash
export DAY_SHIFT_SANDBOX=1
MODE=dry-run node tools/day-shift/dispatch.mjs   # confirm flag picked up (grep 'sandbox' in stderr)
MODE=auto MAX_TICKETS=1 node tools/day-shift/dispatch.mjs   # one live ticket
```
For the LaunchAgent, add `<key>DAY_SHIFT_SANDBOX</key><string>1</string>` under `EnvironmentVariables` in your plist and `launchctl unload && launchctl load` it.

**Rollback:** unset (or omit) `DAY_SHIFT_SANDBOX`. No other change needed — spawn falls back to the previous unsandboxed path.

**Debugging denials:** uncomment `(debug deny)` at the top of `day-shift.sb`, run a ticket, then `log show --predicate 'sender == "Sandbox"' --last 5m --style compact` and grep for the process name. Remove `(debug deny)` before committing — it's noisy.

**Smoke test:** `node --test tools/day-shift/__tests__/sandbox.test.mjs` asserts the profile parses cleanly, allows reads inside `WORKTREE`, and denies reads outside the allowlist. Auto-skips on non-Darwin.

## Files

- `dispatch.mjs` — selection pipeline + lock + Telegram summary
- `worker.mjs` — the local runtime: worktree → `claude -p` (optionally sandboxed, optionally per-pipeline) → gate → draft PR
- `factory-router.mjs` — work-type classifier (hotfix/feature/bug/chore/unknown), opt-in via `DAY_SHIFT_FACTORY_ROUTER=1`
- `pipelines/*.mjs` — per-work-type pipeline definitions (prompt augment + wall-clock override)
- `git.mjs` — guarded git (dayshift/* + holding only, no `--force`)
- `lib.mjs` — naming, holding-branch, identity, config
- `day-shift.sb` — macOS `sandbox-exec` profile (opt-in via `DAY_SHIFT_SANDBOX=1`)
- `prompts/worker-system.md` — the worker's BASE rules (scope, perimeter, zero-credit); per-pipeline augments extend this at runtime
- `com.example.day-shift.plist.template` — LaunchAgent
- safety brain reused from `../night-shift/classifier.mjs` + `preflight.mjs`
