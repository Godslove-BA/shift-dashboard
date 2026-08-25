# Triage UX for autonomous agents — an essay skeleton

> This is a skeleton. Section headings and beats only. The prose is meant to be written in one sitting in the author's own voice — a hiring panel will smell fully-AI prose immediately.

---

## The overnight run and the fifteen-minute window

- The setup: two shifts (day + night) opening PRs against holding branches while I sleep.
- The number I keep landing on is fifteen minutes: what I get before the day starts.
- What the morning actually looks like — coffee, phone, holding branches, verdicts to render.
- The failure mode that made me build this: opening GitHub's PR list at 8 a.m. and drowning.

## Why existing PR list views fail this workflow

- GitHub's PR list sorts by "recently updated" — treats a 500-line refactor and a 4-line rename identically.
- Provides no read on freshness that matches what I actually mean by "fresh."
- Every PR looks equally important; the reviewer has to open each one to know which is real.
- The Projects surface is workflow-stage-based, not temporal — right lens for backlog, wrong lens for triage.

## Design principle 1: freshness > file-count for triage

- The bin cutoffs (14h / 38h / 7d) and why they are wall-clock, not `now - N`.
- Old-flat-sort → new-bucketed: what changed in the first fifteen seconds of the reviewer's morning.
- The `Older` bucket collapses. Reasoning: a week-old PR is either abandoned or being ignored deliberately.
- Alternatives I tried: rolling 24h window, kanban columns, sort-by-additions. Why each was worse.

## Design principle 2: the 5th-grader test

- Every card leads with plain English at 17px.
- Engineer title stays visible in 12px mono below it (auditability).
- The stripping of `(#1234)` from the plain summary — it's already in the ticket link above.
- Why the checklist is a real `<input type="checkbox">`, not a static list.

## Design principle 3: native HTML is not a downgrade

- CSP forces the constraint. The environment gives you nothing else.
- What you get in return: instant TTI, no bundler, no framework upgrade to schedule, testable in `node:test`.
- Theme toggle as URL param + cookie, not client-side JavaScript — solves flash-of-wrong-theme for free.
- Confirmation gating as `<input required pattern="APPROVE">` — cheaper than any JS dialog and requires physical typing.

## The iteration: v4 → v7 in a week

- v4: dense expandable-row table. Killed the KPI grid. Solved density.
- v5: schedule panel at the top of the rail. Answered "when's the next thing" without opening YAML.
- v6: theme toggle, dark + light + auto. Server-side because CSP.
- v7: the 5th-grader-test rework. Freshness bins, plain-English summaries, on-card mutations, no-op deprioritization.
- v7.1: shell-injection guard on the promote recipe, form-action CSP, flash-cookie round-trip.

Beats worth naming in each:
- v4 was density — a solvable engineering problem.
- v5 was one specific friction that the reviewer keeps hitting.
- v6 was the identity vs. the courtesy — dark is who we are, light is who they need us to be.
- v7 was the *emotional* rework — the moment I stopped designing for me and started designing for the junior dev.
- v7.1 was discipline — the moment I stopped adding features and started auditing what I'd just shipped.

## What I'd change if I started over tomorrow

- Persist checkbox state per-reviewer per-PR (currently transient — resets on refresh).
- Ship a real "run night-shift now" button behind a wider token scope; today's dashboard is view-heavy, mutation-thin.
- Move the day-shift interval out of a hardcoded constant into an env var.
- Freshness bins would be user-configurable per repo (14h/38h/7d is right for me, wrong for a team that ships continuously).
- Parameterize the LaunchAgent plist filename hint per repo.
- Add a real E2E smoke test using Playwright against `SYNTHETIC_PRS=1 wrangler dev`.

## Closing thought

<!-- Left blank for the author to finish. -->
