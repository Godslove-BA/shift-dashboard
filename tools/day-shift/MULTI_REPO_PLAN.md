# Multi-repo day-shift / night-shift — the "run this on other projects" plan

This document is a **plan, not code**. It exists so future-you can add day-shift + night-shift to a second (or third) repo without re-inventing the design each time.

## The two options

### Option A - Per-repo copy (fast; short-term OK; scales poorly)

Copy `tools/day-shift/` and `tools/night-shift/` into the target repo, adapt for that repo's safety perimeter, run a second LaunchAgent alongside the the source project one.

**What you do (~1-2 hours per repo):**

1. **Copy the tools** into `<other-repo>/tools/day-shift/` and `<other-repo>/tools/night-shift/`.
2. **Adapt the classifier.** Open `tools/night-shift/classifier.mjs` — the perimeter globs + regex patterns are source-project-specific (`server.js`, `src/services/stripe*`, etc.). Rewrite for the target repo's perimeter. Same shape, different paths.
3. **Adapt the day-shift extra-unsafe list** in `tools/day-shift/dispatch.mjs` (`DAY_SHIFT_EXTRA_UNSAFE` array) - it currently blocks pricing/credit/billing surfaces for the money-safety context the source project has.
4. **Configure a second LaunchAgent.**
   - Copy `tools/day-shift/com.example.day-shift.plist.template`, rename the `Label` (e.g. `com.otherproject.day-shift`) and set `DAY_SHIFT_REPO`, `DAY_SHIFT_PRIMARY_REPO`, `DAY_SHIFT_WORKTREE_ROOT` (must be different from the source project's - `~/day-shift-worktrees-otherproject/`).
   - Install: `launchctl load -w ~/Library/LaunchAgents/com.otherproject.day-shift.plist`
5. **Add a GH secret** on the target repo's Actions settings for night-shift: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (can reuse the same bot; different chat_id if you want channels separated).
6. **Create the shift labels** on the target repo (`day-shift:reviewed-clean`, `night-shift:claude-reviewed-clean`, `day-shift:needs-human`, `night-shift:needs-human`, `day-shift:review-YYYY-MM-DD`, `day-shift:dispatched-YYYY-MM-DD`). `gh label create` in a script, ~10 seconds.

**Cost:** each repo runs its own LaunchAgent + its own `claude -p` processes against your shared Max sub. Concurrent Claude sessions across repos share the 5-hour rolling quota - a busy day of parallel activity across 3 repos will hit fair-use limits faster than one repo.

**Drift risk:** every repo diverges as you iterate the classifier / prompts. Two repos = manageable; five repos = pain.

### Option B - your-org/shifts standalone (right long-term)

Route through the `your-org/shifts` repo (Phase 1 complete per memory `project_shifts_multi_repo_autonomous_coding`). Multi-tenant D1 database, per-tenant classifier + prompts, one deployment serves N repos.

**What you do (~one focused day, once):**

1. `gh auth switch --user <your-github-user>`, `cd ~/Code/shifts`.
2. Run through `docs/SETUP.md` in the Shifts repo (end-to-end walkthrough).
3. Add tenants for each repo you want covered - each gets its own perimeter config, prompts, and credential set stored in D1 with envelope encryption.
4. One LaunchAgent (or one Cloudflare Worker) drives all tenants.

**Cost:** one place to iterate. Adding a 4th repo is a 30-second config, not another 1-2 hours.

**Blocker:** Shifts Phase 2 (adapters for BYO Anthropic/Codex subs on the Mac-local path) not yet run in anger. The original private repo is the only proven tenant so far.

## The recommendation

- **Have 2 repos and don't expect a 3rd?** Option A. Fastest path; drift is bounded.
- **Have 2+ repos AND a plausible 3rd/4th in the next quarter?** Option B is worth the upfront day.
- **Just want to try shifts on ONE other repo to see if the value transfers?** Option A first - if the answer is "yes, this transfers, do more repos," graduate to Option B before you copy a third time.

## What is intentionally NOT solved by this plan

- **Cross-repo ticket dedup** - Option A gives each repo its own issue tracker, no sharing. Option B could unify a "tickets across all tenants" view but currently doesn't.
- **Cross-repo credit tracking** - each multi-tenant repo would need its own credit ceiling; the current `TASK_CREDIT_CEILING` env is repo-local. Fine for now; not a shifts problem.
- **Multi-user (you + a teammate)** - both Options are single-user. Shifts' D1 schema is multi-tenant but the LaunchAgent + `claude -p` local runtime is single-Mac.

## When to actually do this

Only when you have a **real second repo** with tickets that would benefit from autonomous shift coverage. Building the multi-repo infrastructure before you have the second use-case is speculative work - the first real repo you add teaches you 80% of what the plan gets wrong.
